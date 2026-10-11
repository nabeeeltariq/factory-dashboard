const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Matches exact date resolution used in history.html and archive-shift.js (DD-MM-YYYY + shift_start)
function resolveShiftDate(record) {
    if (record.date) {
        const parts = String(record.date).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (parts) {
            return new Date(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1]));
        }
    }
    if (record.shift_start) {
        const d = new Date(Number(record.shift_start));
        if (!isNaN(d.getTime())) return d;
    }
    if (record.saved_at) {
        const d = new Date(Number(record.saved_at));
        if (!isNaN(d.getTime())) return d;
    }
    return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function sanitizeChartReply(replyText) {
    if (!replyText || typeof replyText !== "string") return "";
    const jsonMatch = replyText.match(/```json([\s\S]*?)```/);
    if (!jsonMatch) return replyText.trim();

    try {
        JSON.parse(jsonMatch[1].trim());
        return replyText.trim();
    } catch (e) {
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

        const lowerMsg = message.toLowerCase().trim();

        // 1. Fetch Firebase nodes in parallel
        const HISTORY_URL = "https://automation-60207-default-rtdb.firebaseio.com/shift_history.json";
        const LIVE_URL = "https://automation-60207-default-rtdb.firebaseio.com/shift_data.json";
        const ADJ_URL = "https://automation-60207-default-rtdb.firebaseio.com/shift_adjustments.json";

        const [historyRes, liveRes, adjRes] = await Promise.allSettled([
            fetchWithTimeout(HISTORY_URL, {}, 3500),
            fetchWithTimeout(LIVE_URL, {}, 2500),
            fetchWithTimeout(ADJ_URL, {}, 2500)
        ]);

        const rawHistory = (historyRes.status === "fulfilled" && historyRes.value.ok) ? await historyRes.value.json() : null;
        const liveData = (liveRes.status === "fulfilled" && liveRes.value.ok) ? await liveRes.value.json() : null;
        const adjData = (adjRes.status === "fulfilled" && adjRes.value.ok) ? await adjRes.value.json() : null;

        let adjTotal = 0;
        if (typeof adjData === "number") adjTotal = adjData;
        else if (adjData && typeof adjData === "object") adjTotal = Number(adjData.total) || 0;

        const liveCasesNow = Math.max(0, Number((liveData && liveData.total_cases) || 0) + adjTotal);
        const liveStatusStr = liveData && liveData.line_status ? liveData.line_status : "Shift Inactive";

        // 2. Instant Greeting Handler ("hello", "hi", "hey")
        if (/^(hi|hello|hey|salam|good morning|good evening|help)[\s!?.]*$/i.test(lowerMsg)) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reply: `Hello! I'm your Factory AI Analyst. Right now the line status is **${liveStatusStr}** (${liveCasesNow.toLocaleString()} live cases).\n\nYou can ask me things like:\n• *"30 September production"*\n• *"September total cases and tons"*\n• *"Breakdown time in August"*\n• *"Plot a bar chart of the last 7 shifts"*`
                })
            };
        }

        // 3. Normalize all shift records
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
                    day: d ? d.getDate() : null,
                    month: d ? d.getMonth() : null,
                    year: d ? d.getFullYear() : null,
                    cases,
                    tons,
                    oee,
                    source: s.source === "legacy_manual" ? "legacy_manual" : "automated",
                    downtime_mins: Math.round(trueDowntimeSec / 60),
                    changeover_mins: Math.round(changeoverSec / 60),
                    break_mins: Math.round(breakSec / 60),
                    breakdown_count: Number((r && r.true_breakdown_count) ?? s.breakdown_count ?? 0),
                    variant_totals: variantTotals,
                    variant_tons: variantTons
                };
            });

        // 4. SMART JS FILTER: Detect Specific Date (e.g. "30 september" or "30-09-2026"), Month, or Year
        let matchedMonths = [];
        let requestedDay = null;
        let requestedYear = null;

        // Check full numeric date first: DD-MM-YYYY or DD/MM/YYYY
        const fullDateMatch = lowerMsg.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](202\d))?\b/);
        if (fullDateMatch) {
            requestedDay = Number(fullDateMatch[1]);
            matchedMonths = [Number(fullDateMatch[2]) - 1];
            if (fullDateMatch[3]) requestedYear = Number(fullDateMatch[3]);
        } else {
            // Check year
            const yearMatch = lowerMsg.match(/\b(202\d)\b/);
            if (yearMatch) requestedYear = Number(yearMatch[1]);

            // Check month names
            const words = lowerMsg.replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
            words.forEach(w => {
                if (MONTHS[w] !== undefined && !matchedMonths.includes(MONTHS[w])) {
                    matchedMonths.push(MONTHS[w]);
                }
            });

            // Check day number paired with a month name (e.g. "30 september", "30th sep", "sep 30")
            if (matchedMonths.length === 1) {
                const dayPattern = /\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/g;
                let m;
                while ((m = dayPattern.exec(lowerMsg)) !== null) {
                    const num = Number(m[1]);
                    // Make sure the number isn't part of "last 7 days" or "30 shifts"
                    const afterNum = lowerMsg.slice(m.index + m[0].length).trim();
                    if (!/^(shift|day|week|month|hour|min)/i.test(afterNum)) {
                        requestedDay = num;
                        break;
                    }
                }
            }
        }

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

            if (requestedDay !== null) {
                filteredShifts = filteredShifts.filter(s => s.day === requestedDay);
                filterLabel = `${requestedDay} ${MONTH_NAMES[matchedMonths[0]]}${targetYear ? " " + targetYear : ""}`;
            } else {
                filterLabel = `${matchedMonths.map(m => MONTH_NAMES[m]).join(", ")}${targetYear ? " " + targetYear : ""}`;
            }
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

        // 5. Exact JS Mathematical Aggregator
        function aggregateShifts(shiftsArray) {
            let totalCases = 0, totalTons = 0, totalDowntimeMins = 0, totalChangeoverMins = 0, totalBreakdowns = 0;
            let oeeSum = 0, oeeCount = 0, legacyCount = 0;
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

                Object.entries(s.variant_totals || {}).forEach(([vName, vCases]) => {
                    if (!byVariant[vName]) byVariant[vName] = { cases: 0, tons: 0 };
                    byVariant[vName].cases += Number(vCases || 0);
                    byVariant[vName].tons = Number((byVariant[vName].tons + Number((s.variant_tons && s.variant_tons[vName]) || 0)).toFixed(2));
                });

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
                monthly_rollup: byMonth
            };
        }

        const stats = aggregateShifts(filteredShifts);
        const globalMonthly = aggregateShifts(allShifts).monthly_rollup;

        const compactRows = filteredShifts.slice(-35).map(s => ({
            date: s.date,
            cases: s.cases,
            tons: Number(s.tons.toFixed(2)),
            oee: s.oee !== null ? Number(s.oee.toFixed(1)) : null,
            downtime_mins: s.downtime_mins,
            source: s.source,
            variants: s.variant_totals
        }));

        // 6. System Prompt
        const systemPrompt = `You are the Factory AI Analyst for a Unilever production line.

LIVE ACTIVE SHIFT RIGHT NOW:
Status: ${liveStatusStr}, Live Cases: ${liveCasesNow.toLocaleString()}, Breakdown: ${Math.round(Number((liveData && liveData.breakdown_seconds) || 0) / 60)} mins.

VERIFIED JS-CALCULATED TOTALS FOR "${filterLabel}":
- Matched Shifts: ${stats.shift_count} (${stats.automated_count} automated, ${stats.legacy_count} legacy_manual)
- Total Cases Produced: ${stats.total_cases.toLocaleString()} cases
- Total Tonnage: ${stats.total_tons.toFixed(2)} tons
- Average OEE: ${stats.avg_oee !== null ? stats.avg_oee + "%" : "N/A"}
- Total True Downtime: ${stats.total_downtime_mins} mins (${(stats.total_downtime_mins / 60).toFixed(1)} hrs) across ${stats.total_breakdowns} breakdowns
- Total Changeover Time: ${stats.total_changeover_mins} mins
- Production by Variant: ${JSON.stringify(stats.variants)}

ALL-TIME MONTHLY ROLLUP:
${JSON.stringify(globalMonthly)}

SHIFT RECORDS FOR "${filterLabel}":
${JSON.stringify(compactRows)}

RULES:
1. ALWAYS use the VERIFIED JS-CALCULATED TOTALS above. Never manually add numbers yourself.
2. If Matched Shifts is 0, clearly tell the user no shift record was saved for ${filterLabel}.
3. Be concise and direct (1 to 3 sentences for standard questions).
4. If the matched records include "legacy_manual" shifts, mention that legacy manual entries do not have automated breakdown or hourly timing logs.
5. If the user asks for a graph or chart, output a valid Chart.js configuration wrapped in \`\`\`json and \`\`\` markers.`;

        let replyText = "";
        let aiDebugReason = "";

        // 7. PRIMARY ENGINE: Groq (Tries Llama 3.3 70B, then Llama 3.1 8B Instant)
        const groqKey = (process.env.GROQ_API_KEY || "").trim();
        if (groqKey) {
            const groqModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
            for (const gModel of groqModels) {
                if (replyText) break;
                try {
                    const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${groqKey}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            model: gModel,
                            messages: [
                                { role: "system", content: systemPrompt },
                                { role: "user", content: message }
                            ],
                            temperature: 0.1,
                            max_tokens: 750
                        })
                    }, 4500);

                    if (groqRes.ok) {
                        const groqData = await groqRes.json();
                        replyText = sanitizeChartReply(groqData.choices?.[0]?.message?.content);
                    } else {
                        aiDebugReason = `Groq HTTP ${groqRes.status}`;
                    }
                } catch (err) {
                    aiDebugReason = `Groq ${err.message}`;
                }
            }
        } else {
            aiDebugReason = "GROQ_API_KEY not set in Netlify";
        }

        // 8. BACKUP ENGINE: Direct Gemini REST API (No SDK version issues)
        const geminiKey = (process.env.GEMINI_API_KEY || "").trim();
        if (!replyText && geminiKey) {
            const geminiModels = ["gemini-2.5-flash", "gemini-1.5-flash"];
            for (const mName of geminiModels) {
                if (replyText) break;
                try {
                    const gemUrl = `https://generativelanguage.googleapis.com/v1beta/models/${mName}:generateContent?key=${geminiKey}`;
                    const gemRes = await fetchWithTimeout(gemUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: `${systemPrompt}\n\nUser Question: ${message}` }] }]
                        })
                    }, 4000);

                    if (gemRes.ok) {
                        const gemData = await gemRes.json();
                        const rawText = gemData.candidates?.[0]?.content?.parts?.[0]?.text;
                        replyText = sanitizeChartReply(rawText);
                    }
                } catch (err) {
                    console.warn(`Gemini ${mName} failed:`, err.message);
                }
            }
        }

        // 9. SMART JS FALLBACK (Answers specific dates & variants accurately even without AI)
        if (!replyText) {
            if (stats.shift_count === 0) {
                replyText = `No production shift records were found for **${filterLabel}**.`;
            } else {
                const variantList = Object.entries(stats.variants)
                    .map(([v, d]) => `${v}: ${d.cases.toLocaleString()} cases (${d.tons}t)`)
                    .join(", ");
                const legacyNote = stats.legacy_count > 0
                    ? ` *(Includes ${stats.legacy_count} legacy manual record${stats.legacy_count > 1 ? "s" : ""} without breakdown timing logs)*`
                    : "";

                replyText = `**${filterLabel}:** **${stats.total_cases.toLocaleString()} cases** (**${stats.total_tons.toFixed(2)} tons**) across **${stats.shift_count} shift${stats.shift_count > 1 ? "s" : ""}**${stats.avg_oee ? ` | OEE: **${stats.avg_oee}%**` : ""} | Downtime: **${stats.total_downtime_mins} mins**.${variantList ? `\n• **Variants:** ${variantList}` : ""}${legacyNote}`;
            }
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
