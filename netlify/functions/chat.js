const { GoogleGenerativeAI } = require("@google/generative-ai");

const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Parses DD-MM-YYYY, YYYY-MM-DD, text dates, and timestamps locked to Qatar Time (GMT+3)
function resolveShiftDate(record) {
    const rawStr = record.date || record.shift_date || (record.report && record.report.date);
    if (rawStr) {
        const str = String(rawStr).trim();
        const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (dmy) return { day: Number(dmy[1]), month: Number(dmy[2]) - 1, year: Number(dmy[3]) };

        const ymd = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (ymd) return { day: Number(ymd[3]), month: Number(ymd[2]) - 1, year: Number(ymd[1]) };

        const parsed = new Date(str);
        if (!isNaN(parsed.getTime())) {
            return { day: parsed.getDate(), month: parsed.getMonth(), year: parsed.getFullYear() };
        }
    }

    const ts = Number(record.shift_start || record.saved_at || 0);
    if (ts > 0) {
        const qatarDate = new Date(ts + (3 * 3600 * 1000));
        if (!isNaN(qatarDate.getTime())) {
            return {
                day: qatarDate.getUTCDate(),
                month: qatarDate.getUTCMonth(),
                year: qatarDate.getUTCFullYear()
            };
        }
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

// Instant Native JS Chart.js Builder (Uses 0 AI API calls and guarantees valid JSON)
function buildNativeChartReply(lowerMsg, filterLabel, stats, filteredShifts, globalMonthly) {
    const wantsTons = /\b(ton|tons|tonnage)\b/i.test(lowerMsg) && !/\b(case|cases)\b/i.test(lowerMsg);
    const wantsDowntime = /\b(downtime|breakdown|stoppage)\b/i.test(lowerMsg);
    const wantsOee = /\b(oee|efficiency)\b/i.test(lowerMsg);
    const isPie = /\b(pie|doughnut|donut)\b/i.test(lowerMsg);
    const isLine = /\b(line|trend)\b/i.test(lowerMsg);

    const palette = [
        "#0d9488", "#4f46e5", "#0284c7", "#10b981", "#f59e0b",
        "#e11d48", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
        "#f97316", "#6366f1"
    ];

    let labels = [];
    let dataValues = [];
    let datasetLabel = "";
    let chartTitle = "";

    // 1. Variant Breakdown Chart
    if (/(variant|sku|product|across all|what we produced)/i.test(lowerMsg) && Object.keys(stats.variants).length > 0) {
        const sortedVariants = Object.entries(stats.variants)
            .sort((a, b) => (wantsTons ? b[1].tons - a[1].tons : b[1].cases - a[1].cases));

        labels = sortedVariants.map(([v]) => v);
        dataValues = sortedVariants.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Tons Produced" : "Cases Produced";
        chartTitle = `${filterLabel} — Production by Variant (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 2. Monthly Rollup Chart
    else if (/\b(monthly|by month|each month|months)\b/i.test(lowerMsg)) {
        const monthEntries = Object.entries(globalMonthly);
        labels = monthEntries.map(([m]) => m);
        dataValues = monthEntries.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Monthly Tons" : "Monthly Cases";
        chartTitle = `Monthly Production (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 3. Shift-by-Shift / Daily Chart
    else {
        const slice = filteredShifts.slice(-30);
        labels = slice.map(s => s.date);
        if (wantsDowntime) {
            dataValues = slice.map(s => s.downtime_mins);
            datasetLabel = "Downtime (Mins)";
            chartTitle = `${filterLabel} — Downtime per Shift (Mins)`;
        } else if (wantsOee) {
            dataValues = slice.map(s => s.oee !== null ? Number(s.oee.toFixed(1)) : 0);
            datasetLabel = "OEE (%)";
            chartTitle = `${filterLabel} — OEE % per Shift`;
        } else if (wantsTons) {
            dataValues = slice.map(s => Number(s.tons.toFixed(2)));
            datasetLabel = "Tons Produced";
            chartTitle = `${filterLabel} — Tonnage per Shift`;
        } else {
            dataValues = slice.map(s => s.cases);
            datasetLabel = "Cases Produced";
            chartTitle = `${filterLabel} — Cases per Shift`;
        }
    }

    const chartType = isPie ? "doughnut" : (isLine ? "line" : "bar");
    const chartConfig = {
        type: chartType,
        data: {
            labels: labels,
            datasets: [{
                label: datasetLabel,
                data: dataValues,
                backgroundColor: isPie ? palette.slice(0, labels.length) : (wantsDowntime ? "#e11d48" : "#0d9488"),
                borderColor: isPie ? "#ffffff" : (wantsDowntime ? "#be123c" : "#0f766e"),
                borderWidth: 1,
                borderRadius: chartType === "bar" ? 6 : 0,
                fill: chartType === "line" ? false : true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: isPie, position: "bottom" },
                title: { display: true, text: chartTitle, font: { size: 14, weight: "bold" } }
            },
            scales: isPie ? {} : {
                y: { beginAtZero: true }
            }
        }
    };

    const summaryLine = `**${chartTitle}:** Total of **${stats.total_cases.toLocaleString()} cases** (**${stats.total_tons.toFixed(2)} tons**) across **${stats.shift_count} shifts**.`;
    return "```json\n" + JSON.stringify(chartConfig) + "\n```\n" + summaryLine;
}

// Focused, Question-Specific Direct JS Responder
function buildFocusedJSReply(lowerMsg, filterLabel, stats, allShifts, matchedMonths, targetYear) {
    if (stats.shift_count === 0) {
        if (matchedMonths.length === 1) {
            const monthShifts = allShifts.filter(s => s.month === matchedMonths[0] && (!targetYear || s.year === targetYear));
            if (monthShifts.length > 0) {
                const availableDates = [...new Set(monthShifts.map(s => s.date))].join(", ");
                return `No production shift was recorded on **${filterLabel}**. Shifts recorded in **${MONTH_NAMES[matchedMonths[0]]}** were on: **${availableDates}**.`;
            }
        }
        return `No production shift records were found for **${filterLabel}**.`;
    }

    const asksDowntime = /(breakdown|downtime|stoppage|stopped|fault|changeover)/i.test(lowerMsg);
    const asksTonsOnly = /(ton|tonnage|weight)/i.test(lowerMsg) && !/(case|variant|sku|what we produced|breakdown)/i.test(lowerMsg);
    const asksCasesOnly = /\b(case|cases|boxes)\b/i.test(lowerMsg) && !/(ton|variant|sku|what we produced|breakdown)/i.test(lowerMsg);
    const asksOeeOnly = /\b(oee|efficiency|target)\b/i.test(lowerMsg);

    const legacyNote = stats.legacy_count > 0
        ? ` *(Note: ${stats.legacy_count} of ${stats.shift_count} shifts are legacy manual entries without automated breakdown timing logs.)*`
        : "";

    if (asksDowntime) {
        if (stats.legacy_count === stats.shift_count) {
            return `In **${filterLabel}**, recorded breakdown time is **0 mins** because all **${stats.shift_count} shifts** are **legacy manual entries** (which do not store automated breakdown timing logs).`;
        }
        return `**${filterLabel} Downtime:** **${stats.total_downtime_mins} mins** (${(stats.total_downtime_mins / 60).toFixed(1)} hrs) across **${stats.total_breakdowns} breakdowns**, plus **${stats.total_changeover_mins} mins** of changeover time.${legacyNote}`;
    }

    if (asksTonsOnly) {
        return `**${filterLabel} Total Tonnage:** **${stats.total_tons.toFixed(2)} tons** (${stats.total_cases.toLocaleString()} cases across ${stats.shift_count} shifts).`;
    }

    if (asksCasesOnly) {
        return `**${filterLabel} Total Cases:** **${stats.total_cases.toLocaleString()} cases** (${stats.total_tons.toFixed(2)} tons across ${stats.shift_count} shifts).`;
    }

    if (asksOeeOnly) {
        return stats.avg_oee !== null
            ? `**${filterLabel} Average OEE:** **${stats.avg_oee}%** across ${stats.shift_count} shifts (${stats.total_cases.toLocaleString()} cases / ${stats.total_tons.toFixed(2)} tons).`
            : `No OEE percentage was calculated for **${filterLabel}**.`;
    }

    const variantList = Object.entries(stats.variants)
        .sort((a, b) => b[1].cases - a[1].cases)
        .map(([v, d]) => `${v}: **${d.cases.toLocaleString()} cases** (${d.tons}t)`)
        .join(", ");

    return `**${filterLabel}:** **${stats.total_cases.toLocaleString()} cases** (**${stats.total_tons.toFixed(2)} tons**) across **${stats.shift_count} shift${stats.shift_count > 1 ? "s" : ""}**${stats.avg_oee ? ` | OEE: **${stats.avg_oee}%**` : ""} | Downtime: **${stats.total_downtime_mins} mins**.${variantList ? `\n• **Variants:** ${variantList}` : ""}${legacyNote}`;
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

        // 2. Instant Greeting Handler (0 AI Calls)
        if (/^(hi|hello|hey|salam|good morning|good evening|help)[\s!?.]*$/i.test(lowerMsg)) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reply: `Hello! I'm your Factory AI Analyst. Right now the line status is **${liveStatusStr}** (${liveCasesNow.toLocaleString()} live cases).\n\nAsk me anything about your production, such as:\n• *"Make a graph of variants in September"*\n• *"How many total tons till now?"*\n• *"What we produced on 30 September?"*\n• *"Breakdown time in August"*`
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
                const cases = Number(s.total_cases || s.cases || s.cases_produced || 0);
                const tons = Number((r && r.total_tons) || s.tonnage || s.tons || 0);
                const rawDowntimeSec = Number(s.total_downtime_seconds || 0);
                const trueDowntimeSec = Number((r && r.true_downtime_seconds) ?? rawDowntimeSec);
                const changeoverSec = Number((r && r.changeover_time_seconds) || 0);
                const breakSec = Number((r && r.break_time_seconds) || 0);
                const oee = (r && typeof r.oee_percent === "number") ? Number(r.oee_percent) : null;
                const variantTotals = (r && r.variant_totals) ? r.variant_totals : {};
                const variantTons = (r && r.variant_tons) ? r.variant_tons : {};

                const formattedDate = s.date || s.shift_date || (d ? `${String(d.day).padStart(2, "0")}-${String(d.month + 1).padStart(2, "0")}-${d.year}` : "Unknown");

                return {
                    date: formattedDate,
                    day: d ? d.day : null,
                    month: d ? d.month : null,
                    year: d ? d.year : null,
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

        // 4. SMART JS FILTER: Specific Date, Month, Year, or "Till Now / Overall"
        let matchedMonths = [];
        let requestedDay = null;
        let requestedYear = null;

        const nowQatar = new Date(Date.now() + (3 * 3600 * 1000));
        const currentYear = nowQatar.getUTCFullYear();
        const currentMonth = nowQatar.getUTCMonth();

        const fullDateMatch = lowerMsg.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](202\d))?\b/);
        if (fullDateMatch) {
            requestedDay = Number(fullDateMatch[1]);
            matchedMonths = [Number(fullDateMatch[2]) - 1];
            if (fullDateMatch[3]) requestedYear = Number(fullDateMatch[3]);
        } else {
            const yearMatch = lowerMsg.match(/\b(202\d)\b/);
            if (yearMatch) requestedYear = Number(yearMatch[1]);
            else if (lowerMsg.includes("this year") || lowerMsg.includes("current year")) {
                requestedYear = currentYear;
            }

            const words = lowerMsg.replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
            words.forEach(w => {
                if (MONTHS[w] !== undefined && !matchedMonths.includes(MONTHS[w])) {
                    matchedMonths.push(MONTHS[w]);
                }
            });

            if (matchedMonths.length === 1) {
                const dayPattern = /\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/g;
                let m;
                while ((m = dayPattern.exec(lowerMsg)) !== null) {
                    const num = Number(m[1]);
                    const afterNum = lowerMsg.slice(m.index + m[0].length).trim();
                    if (!/^(shift|day|week|month|hour|min|ton|case)/i.test(afterNum)) {
                        requestedDay = num;
                        break;
                    }
                }
            }
        }

        if (lowerMsg.includes("this month") || lowerMsg.includes("current month")) {
            matchedMonths = [currentMonth];
        } else if (lowerMsg.includes("last month") || lowerMsg.includes("previous month")) {
            matchedMonths = [(currentMonth + 11) % 12];
        }

        let filteredShifts = allShifts;
        let filterLabel = "All Recorded History";
        let targetYear = requestedYear;

        if (requestedYear) {
            filteredShifts = filteredShifts.filter(s => s.year === requestedYear);
            filterLabel = `Year ${requestedYear}`;
        }

        const asksAllTime = /(till now|til now|so far|till date|to date|overall|all time|all shift|history|total ton|total case|total production|ever)/i.test(lowerMsg);

        if (matchedMonths.length > 0) {
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
        } else if (!requestedYear && !asksAllTime) {
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

        // 6. Zero-AI Fast Path for Empty Dates & Chart/Graph Requests
        if (stats.shift_count === 0) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reply: buildFocusedJSReply(lowerMsg, filterLabel, stats, allShifts, matchedMonths, targetYear)
                })
            };
        }

        const wantsChart = /\b(graph|chart|plot|visual|bar|pie|doughnut|line)\b/i.test(lowerMsg);
        if (wantsChart) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reply: buildNativeChartReply(lowerMsg, filterLabel, stats, filteredShifts, globalMonthly)
                })
            };
        }

        // 7. System Prompt for Groq AI (Active 2026 Models: openai/gpt-oss-120b & openai/gpt-oss-20b)
        const compactRows = filteredShifts.slice(-30).map(s => ({
            date: s.date,
            cases: s.cases,
            tons: Number(s.tons.toFixed(2)),
            oee: s.oee !== null ? Number(s.oee.toFixed(1)) : null,
            downtime_mins: s.downtime_mins,
            source: s.source,
            variants: s.variant_totals
        }));

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

STRICT RULES:
1. ALWAYS use the VERIFIED JS-CALCULATED TOTALS above. Never manually add numbers yourself.
2. Answer ONLY the specific question asked in 1 to 2 sentences:
   - If the user asks for "total tons", give ONLY the tonnage (and shift/case count briefly). Do NOT list variants or downtime.
   - If the user asks for "breakdown time", give ONLY the downtime minutes and mention if shifts are legacy_manual. Do NOT list variants or cases.
   - Only list the variant breakdown if the user asks "what we produced" on a date or asks about variants/SKUs.`;

        let replyText = "";

        // 8. PRIMARY ENGINE: Groq Active 2026 Models (openai/gpt-oss-120b -> openai/gpt-oss-20b)
        const groqKey = (process.env.GROQ_API_KEY || "").trim();
        if (groqKey) {
            const groqModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
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
                            max_tokens: 600
                        })
                    }, 4500);

                    if (groqRes.ok) {
                        const groqData = await groqRes.json();
                        replyText = sanitizeChartReply(groqData.choices?.[0]?.message?.content);
                    }
                } catch (err) {
                    console.warn("Groq failover:", err.message);
                }
            }
        }

        // 9. FOCUSED JS RESPONDER FALLBACK
        if (!replyText) {
            replyText = buildFocusedJSReply(lowerMsg, filterLabel, stats, allShifts, matchedMonths, targetYear);
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
