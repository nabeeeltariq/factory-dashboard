const { GoogleGenerativeAI } = require("@google/generative-ai");

const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Matches the exact date resolution used in history.html and archive-shift.js (DD-MM-YYYY + shift_start)
function resolveShiftDate(record) {
    if (record.shift_start) {
        const d = new Date(Number(record.shift_start));
        if (!isNaN(d.getTime())) return d;
    }
    if (record.date) {
        const parts = String(record.date).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (parts) {
            return new Date(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1]));
        }
        const parsed = new Date(record.date);
        if (!isNaN(parsed.getTime())) return parsed;
    }
    if (record.saved_at) {
        const d = new Date(Number(record.saved_at));
        if (!isNaN(d.getTime())) return d;
    }
    return null;
}

// Strict timeout wrapper so Netlify never hits the 10s free-tier kill switch
async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Validates Chart.js JSON blocks so history.html never crashes on JSON.parse()
function sanitizeChartReply(replyText) {
    if (!replyText || typeof replyText !== "string") return "";
    const jsonMatch = replyText.match(/```json([\s\S]*?)```/);
    if (!jsonMatch) return replyText.trim();

    try {
        JSON.parse(jsonMatch[1].trim());
        return replyText.trim();
    } catch (e) {
        // If AI wrote malformed JSON, strip the broken block so text still renders cleanly
        return replyText.replace(jsonMatch[0], "").trim();
    }
}

exports.handler = async function(event, context) {
    context.callbackWaitsForEmptyEventLoop = false;

    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const message = (body.message || "").trim();
        if (!message) {
            return { statusCode: 200, body: JSON.stringify({ reply: "Please enter a question about your factory data." }) };
        }

        const lowerMsg = message.toLowerCase();

        // 1. Fetch shift_history, live shift_data, and shift_adjustments in parallel
        const HISTORY_URL = "https://automation-60207-default-rtdb.firebaseio.com/shift_history.json";
        const LIVE_URL = "https://automation-60207-default-rtdb.firebaseio.com/shift_data.json";
        const ADJ_URL = "https://automation-60207-default-rtdb.firebaseio.com/shift_adjustments.json";

        const [historyRes, liveRes, adjRes] = await Promise.allSettled([
            fetchWithTimeout(HISTORY_URL, {}, 3500),
            fetchWithTimeout(LIVE_URL, {}, 2500),
            fetchWithTimeout(ADJ_URL, {}, 2500)
        ]);

        const rawHistory = (historyRes.status === "fulfilled" && historyRes.value.ok)
            ? await historyRes.value.json()
            : null;
        const liveData = (liveRes.status === "fulfilled" && liveRes.value.ok)
            ? await liveRes.value.json()
            : null;
        const adjData = (adjRes.status === "fulfilled" && adjRes.value.ok)
            ? await adjRes.value.json()
            : null;

        // Match archive-shift.js adjustment structure: adjustmentsData.total
        let adjTotal = 0;
        if (typeof adjData === "number") {
            adjTotal = adjData;
        } else if (adjData && typeof adjData === "object") {
            adjTotal = Number(adjData.total) || 0;
        }

        // 2. Normalize all shift records using your exact history.html & archive-shift.js schema
        const rawEntries = rawHistory ? Object.values(rawHistory) : [];
        const allShifts = rawEntries
            .filter(Boolean)
            .sort((a, b) => (a.shift_start || a.saved_at || 0) - (b.shift_start || b.saved_at || 0))
            .map(s => {
                const d = resolveShiftDate(s);
                const r = s.report || null;
                const cases = Number(s.total_cases || 0);
                const tons = Number((r && r.total_tons) || s.tonnage || s.tons || 0);
                const rawDowntimeSec = Number(s.total_downtime_seconds || 0);
                const trueDowntimeSec = Number((r && r.true_downtime_seconds) ?? rawDowntimeSec);
                const changeoverSec = Number((r && r.changeover_time_seconds) || 0);
                const breakSec = Number((r && r.break_time_seconds) || 0);
                const oee = (r && typeof r.oee_percent === "number") ? Number(r.oee_percent) : null;
                const variantTotals = (r && r.variant_totals) ? r.variant_totals : {};
                const variantTons = (r && r.variant_tons) ? r.variant_tons : {};

                return {
                    date: s.date || (d ? `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}` : "Unknown"),
                    year: d ? d.getFullYear() : null,
                    month: d ? d.getMonth() : null,
                    cases,
                    tons,
                    oee,
                    has_report: !!r,
                    source: s.source === "legacy_manual" ? "legacy_manual" : "automated",
                    downtime_mins: Math.round(trueDowntimeSec / 60),
                    changeover_mins: Math.round(changeoverSec / 60),
                    break_mins: Math.round(breakSec / 60),
                    breakdown_count: Number((r && r.true_breakdown_count) ?? s.breakdown_count ?? 0),
                    variant_totals: variantTotals,
                    variant_tons: variantTons
                };
            });

        // 3. SMART JS FILTER: Filter by Month, Year, Relative Range, or Variant
        let matchedMonths = [];
        const words = lowerMsg.replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
        words.forEach(w => {
            if (MONTHS[w] !== undefined && !matchedMonths.includes(MONTHS[w])) {
                matchedMonths.push(MONTHS[w]);
            }
        });

        const yearMatch = lowerMsg.match(/\b(202\d)\b/);
        const requestedYear = yearMatch ? Number(yearMatch[1]) : null;

        const now = new Date();
        if (lowerMsg.includes("this month") || lowerMsg.includes("current month")) {
            matchedMonths = [now.getMonth()];
        } else if (lowerMsg.includes("last month") || lowerMsg.includes("previous month")) {
            matchedMonths = [(now.getMonth() + 11) % 12];
        }

        let filteredShifts = allShifts;
        let filterLabel = "All Recorded History";

        if (requestedYear) {
            filteredShifts = filteredShifts.filter(s => s.year === requestedYear);
            filterLabel = `Year ${requestedYear}`;
        }

        if (matchedMonths.length > 0) {
            let targetYear = requestedYear;
            if (!targetYear) {
                const availableYears = filteredShifts
                    .filter(s => matchedMonths.includes(s.month) && s.year)
                    .map(s => s.year);
                if (availableYears.length > 0) targetYear = Math.max(...availableYears);
            }
            filteredShifts = filteredShifts.filter(s =>
                matchedMonths.includes(s.month) && (!targetYear || s.year === targetYear)
            );
            filterLabel = `${matchedMonths.map(m => MONTH_NAMES[m]).join(", ")}${targetYear ? " " + targetYear : ""}`;
        } else if (lowerMsg.includes("last 7") || lowerMsg.includes("last week") || lowerMsg.includes("past week")) {
            filteredShifts = allShifts.slice(-7);
            filterLabel = "Last 7 Shifts";
        } else if (lowerMsg.includes("last shift") || lowerMsg.includes("latest shift") || lowerMsg.includes("yesterday")) {
            filteredShifts = allShifts.slice(-1);
            filterLabel = "Latest Shift";
        } else if (!requestedYear && !lowerMsg.includes("all") && !lowerMsg.includes("year") && !lowerMsg.includes("history")) {
            filteredShifts = allShifts.slice(-30);
            filterLabel = "Latest 30 Shifts";
        }

        // 4. Exact JavaScript Mathematical Aggregator (Zero AI Math Hallucinations)
        function aggregateShifts(shiftsArray) {
            let totalCases = 0;
            let totalTons = 0;
            let totalDowntimeMins = 0;
            let totalChangeoverMins = 0;
            let totalBreakdowns = 0;
            let oeeSum = 0;
            let oeeCount = 0;
            let legacyCount = 0;
            const byVariant = {};
            const byMonth = {};

            shiftsArray.forEach(s => {
                totalCases += s.cases;
                totalTons += s.tons;
                totalDowntimeMins += s.downtime_mins;
                totalChangeoverMins += s.changeover_mins;
                totalBreakdowns += s.breakdown_count;
                if (s.source === "legacy_manual") legacyCount++;
                if (s.oee !== null && s.oee > 0) {
                    oeeSum += s.oee;
                    oeeCount++;
                }

                // Aggregate per-variant cases and tons from report
                Object.entries(s.variant_totals || {}).forEach(([vName, vCases]) => {
                    if (!byVariant[vName]) byVariant[vName] = { cases: 0, tons: 0 };
                    byVariant[vName].cases += Number(vCases || 0);
                    byVariant[vName].tons = Number((byVariant[vName].tons + Number((s.variant_tons && s.variant_tons[vName]) || 0)).toFixed(2));
                });

                // Aggregate per-month summary
                const mKey = (s.year && s.month !== null) ? `${MONTH_NAMES[s.month]} ${s.year}` : "Unknown";
                if (!byMonth[mKey]) byMonth[mKey] = { shifts: 0, cases: 0, tons: 0, legacy_shifts: 0 };
                byMonth[mKey].shifts += 1;
                byMonth[mKey].cases += s.cases;
                byMonth[mKey].tons = Number((byMonth[mKey].tons + s.tons).toFixed(2));
                if (s.source === "legacy_manual") byMonth[mKey].legacy_shifts += 1;
            });

            return {
                shift_count: shiftsArray.length,
                legacy_count: legacyCount,
                automated_count: shiftsArray.length - legacyCount,
                total_cases: totalCases,
                total_tons: Number(totalTons.toFixed(2)),
                avg_oee: oeeCount > 0 ? Number((oeeSum / oeeCount).toFixed(2)) : null,
                total_downtime_mins: totalDowntimeMins,
                total_changeover_mins: totalChangeoverMins,
                total_breakdowns: totalBreakdowns,
                variants: byVariant,
                monthly_Rollup: byMonth
            };
        }

        const stats = aggregateShifts(filteredShifts);
        const globalMonthly = aggregateShifts(allShifts).monthly_Rollup;

        // Only send compact daily rows (max 35) to keep payload tiny and fast
        const compactRows = filteredShifts.slice(-35).map(s => ({
            date: s.date,
            cases: s.cases,
            tons: Number(s.tons.toFixed(2)),
            oee: s.oee !== null ? Number(s.oee.toFixed(1)) : null,
            downtime_mins: s.downtime_mins,
            source: s.source,
            variants: s.variant_totals
        }));

        const liveCasesNow = Math.max(0, Number((liveData && liveData.total_cases) || 0) + adjTotal);
        const liveStatusText = liveData
            ? `Status: ${liveData.line_status || "Shift Inactive"}, Live Cases (with adjustments): ${liveCasesNow.toLocaleString()}, Breakdown: ${Math.round(Number(liveData.breakdown_seconds || 0) / 60)} mins`
            : "No active shift running right now.";

        // 5. Build System Prompt with Pre-Calculated JS Numbers
        const systemPrompt = `You are the Factory AI Analyst for a Unilever production line.

LIVE ACTIVE SHIFT RIGHT NOW:
${liveStatusText}

VERIFIED JS-CALCULATED TOTALS FOR "${filterLabel}":
- Total Shifts: ${stats.shift_count} (${stats.automated_count} automated, ${stats.legacy_count} legacy_manual)
- Total Cases Produced: ${stats.total_cases.toLocaleString()} cases
- Total Tonnage: ${stats.total_tons.toFixed(2)} tons
- Average OEE: ${stats.avg_oee !== null ? stats.avg_oee + "%" : "N/A"}
- Total True Downtime: ${stats.total_downtime_mins} mins (${(stats.total_downtime_mins / 60).toFixed(1)} hrs) across ${stats.total_breakdowns} breakdowns
- Total Changeover Time: ${stats.total_changeover_mins} mins
- Production by Variant (Cases & Tons): ${JSON.stringify(stats.variants)}

ALL-TIME MONTHLY ROLLUP:
${JSON.stringify(globalMonthly)}

SHIFT-BY-SHIFT RECORDS FOR "${filterLabel}":
${JSON.stringify(compactRows)}

STRICT RULES:
1. ALWAYS use the VERIFIED JS-CALCULATED TOTALS or ALL-TIME MONTHLY ROLLUP above. Never manually add numbers yourself.
2. Be extremely concise and direct (1 to 3 sentences for standard questions).
3. For general questions (e.g., "tell me August production"), state ONLY the final total cases and total tons (and OEE if relevant) in 1–2 sentences. Do NOT list shift-by-shift details unless explicitly asked.
4. If the matched records include "legacy_manual" shifts, briefly mention that legacy manual records do not contain automated breakdown or hourly timing logs.
5. If the user asks for a graph, chart, or visual plot, output a valid Chart.js configuration object wrapped inside \`\`\`json and \`\`\` markers, followed by a 1-sentence summary.`;

        let replyText = "";

        // 6. PRIMARY AI ENGINE: Groq (Llama 3.3 70B - ~0.3s response)
        if (process.env.GROQ_API_KEY) {
            try {
                const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: "llama-3.3-70b-versatile",
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: message }
                        ],
                        temperature: 0.1,
                        max_tokens: 750
                    })
                }, 4800);

                if (groqRes.ok) {
                    const groqData = await groqRes.json();
                    replyText = sanitizeChartReply(groqData.choices?.[0]?.message?.content);
                } else {
                    console.warn("Groq HTTP status:", groqRes.status);
                }
            } catch (err) {
                console.warn("Groq failover:", err.message);
            }
        }

        // 7. BACKUP AI ENGINE: Gemini Flash (Instant failover if Groq key is missing or busy)
        if (!replyText && process.env.GEMINI_API_KEY) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const backupModels = ["gemini-2.5-flash", "gemini-2.0-flash"];

            for (const modelName of backupModels) {
                if (replyText) break;
                try {
                    const model = genAI.getGenerativeModel({ model: modelName });
                    const result = await model.generateContent([systemPrompt, message]);
                    replyText = sanitizeChartReply(result.response.text());
                } catch (err) {
                    console.warn(`Gemini ${modelName} error:`, err.message);
                }
            }
        }

        // 8. GUARANTEED NON-BLANK FALLBACK (Direct JS answer if all AI APIs are unreachable)
        if (!replyText) {
            replyText = `**${filterLabel} Summary:** **${stats.total_cases.toLocaleString()} cases** (**${stats.total_tons.toFixed(2)} tons**) across **${stats.shift_count} shifts**${stats.avg_oee ? ` with an average OEE of **${stats.avg_oee}%**` : ""}. Total downtime: **${stats.total_downtime_mins} mins**.`;
        }

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reply: replyText })
        };

    } catch (error) {
        console.error("Chat function error:", error);
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                reply: `⚠️ Unable to process that request right now (${error.message}). Please try again.`
            })
        };
    }
};
