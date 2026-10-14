const { GoogleGenerativeAI } = require("@google/generative-ai");

const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Format epoch timestamp into Qatar Time (GMT+3) HH:MM AM/PM
function formatQatarTime(ts) {
    if (!ts) return "--:--";
    const d = new Date(Number(ts) + (3 * 3600 * 1000));
    if (isNaN(d.getTime())) return "--:--";
    let h = d.getUTCHours();
    const m = String(d.getUTCMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
}

// Parses DD-MM-YYYY, YYYY-MM-DD, text dates, and timestamps locked to Qatar Time (GMT+3)
function resolveShiftDate(record) {
    const rawStr = record.date || record.shift_date || (record.report && record.report.date);
    if (rawStr) {
        const str = String(rawStr).trim();
        const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (dmy) {
            const day = Number(dmy[1]), month = Number(dmy[2]) - 1, year = Number(dmy[3]);
            return { day, month, year, dayValue: Date.UTC(year, month, day) };
        }

        const ymd = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (ymd) {
            const year = Number(ymd[1]), month = Number(ymd[2]) - 1, day = Number(ymd[3]);
            return { day, month, year, dayValue: Date.UTC(year, month, day) };
        }

        const parsed = new Date(str);
        if (!isNaN(parsed.getTime())) {
            const day = parsed.getDate(), month = parsed.getMonth(), year = parsed.getFullYear();
            return { day, month, year, dayValue: Date.UTC(year, month, day) };
        }
    }

    const ts = Number(record.shift_start || record.saved_at || 0);
    if (ts > 0) {
        const qatarDate = new Date(ts + (3 * 3600 * 1000));
        if (!isNaN(qatarDate.getTime())) {
            const day = qatarDate.getUTCDate(), month = qatarDate.getUTCMonth(), year = qatarDate.getUTCFullYear();
            return { day, month, year, dayValue: Date.UTC(year, month, day) };
        }
    }
    return null;
}

// Parses custom "From - To" date ranges (e.g., "from 5 sep to 18 sep" or "05-09-2026 to 18-09-2026")
function parseCustomDateRange(text, defaultYear) {
    // 1. Numeric range: DD-MM-YYYY to DD-MM-YYYY
    const numRange = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](202\d))?\s*(?:to|till|until|\-|through|and)\s*(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](202\d))?\b/i);
    if (numRange) {
        const d1 = Number(numRange[1]), m1 = Number(numRange[2]) - 1, y1 = numRange[3] ? Number(numRange[3]) : defaultYear;
        const d2 = Number(numRange[4]), m2 = Number(numRange[5]) - 1, y2 = numRange[6] ? Number(numRange[6]) : y1;
        return {
            startVal: Date.UTC(y1, m1, d1),
            endVal: Date.UTC(y2, m2, d2),
            label: `${d1} ${MONTH_NAMES[m1]} ${y1} to ${d2} ${MONTH_NAMES[m2]} ${y2}`
        };
    }

    // 2. Text month range: "from 5 sep to 18 sep" or "between 10 august and 25 august"
    const monthNamesRegex = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
    const textRange1 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthNamesRegex})?\\s*(?:to|till|until|\\-|through|and)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthNamesRegex})\\b`, "i");
    const mMatch = text.match(textRange1);
    if (mMatch) {
        const d1 = Number(mMatch[1]);
        const d2 = Number(mMatch[3]);
        const m2 = MONTHS[mMatch[4].toLowerCase()];
        const m1 = mMatch[2] ? MONTHS[mMatch[2].toLowerCase()] : m2;
        if (m1 !== undefined && m2 !== undefined) {
            return {
                startVal: Date.UTC(defaultYear, m1, d1),
                endVal: Date.UTC(defaultYear, m2, d2),
                label: `${d1} ${MONTH_NAMES[m1]} to ${d2} ${MONTH_NAMES[m2]} ${defaultYear}`
            };
        }
    }
    return null;
}

// Extracts timeframe filter from a user query string
function extractTimeFilter(queryText, allShifts, currentYear, currentMonth) {
    const lower = (queryText || "").toLowerCase().trim();

    // Check custom date range first
    const availableYears = allShifts.filter(s => s.year).map(s => s.year);
    const latestYearInDb = availableYears.length > 0 ? Math.max(...availableYears) : currentYear;
    const customRange = parseCustomDateRange(lower, latestYearInDb);
    if (customRange) {
        return { type: "range", range: customRange };
    }

    let matchedMonths = [];
    let requestedDay = null;
    let requestedYear = null;

    const fullDateMatch = lower.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](202\d))?\b/);
    if (fullDateMatch) {
        requestedDay = Number(fullDateMatch[1]);
        matchedMonths = [Number(fullDateMatch[2]) - 1];
        if (fullDateMatch[3]) requestedYear = Number(fullDateMatch[3]);
    } else {
        const yearMatch = lower.match(/\b(202\d)\b/);
        if (yearMatch) requestedYear = Number(yearMatch[1]);
        else if (lower.includes("this year") || lower.includes("current year")) {
            requestedYear = currentYear;
        }

        const words = lower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
        words.forEach(w => {
            if (MONTHS[w] !== undefined && !matchedMonths.includes(MONTHS[w])) {
                matchedMonths.push(MONTHS[w]);
            }
        });

        if (matchedMonths.length === 1) {
            const dayPattern = /\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/g;
            let m;
            while ((m = dayPattern.exec(lower)) !== null) {
                const num = Number(m[1]);
                const afterNum = lower.slice(m.index + m[0].length).trim();
                if (!/^(shift|day|week|month|hour|min|ton|case)/i.test(afterNum)) {
                    requestedDay = num;
                    break;
                }
            }
        }
    }

    if (lower.includes("this month") || lower.includes("current month")) {
        matchedMonths = [currentMonth];
    } else if (lower.includes("last month") || lower.includes("previous month")) {
        matchedMonths = [(currentMonth + 11) % 12];
    }

    if (matchedMonths.length > 0 || requestedYear !== null) {
        return { type: "calendar", matchedMonths, requestedDay, requestedYear };
    }
    if (lower.includes("last 30") || lower.includes("recent 30")) {
        return { type: "slice", count: 30, label: "Latest 30 Shifts" };
    }
    if (lower.includes("last 7") || lower.includes("last week") || lower.includes("past week")) {
        return { type: "slice", count: 7, label: "Last 7 Shifts" };
    }
    if (lower.includes("last shift") || lower.includes("latest shift") || lower.includes("yesterday")) {
        return { type: "slice", count: 1, label: "Latest Shift" };
    }
    if (/(all time|all shift|history|till now|til now|so far|overall|ever)/i.test(lower)) {
        return { type: "all", label: "All Recorded History" };
    }

    return { type: "none" };
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

function formatForChatUI(replyText) {
    if (!replyText || typeof replyText !== "string") return "";

    let text = replyText.trim();
    const jsonMatch = text.match(/```json([\s\S]*?)```/);
    if (jsonMatch) {
        try {
            JSON.parse(jsonMatch[1].trim());
        } catch (e) {
            text = text.replace(jsonMatch[0], "").trim();
        }
    }

    return text
        .replace(/^#{1,4}\s+(.*)$/gm, "**$1**")
        .replace(/^- /gm, "• ");
}

// Upgraded Native JS Chart.js Builder (Supports Grouped Brand Comparison, Hourly Charts, Variant, Monthly & Shift Charts)
function buildNativeChartReply(lowerMsg, filterLabel, stats, filteredShifts, globalMonthly) {
    const wantsTons = /\b(ton|tons|tonnage)\b/i.test(lowerMsg) && !/\b(case|cases)\b/i.test(lowerMsg);
    const wantsDowntime = /\b(downtime|breakdown|stoppage)\b/i.test(lowerMsg);
    const wantsOee = /\b(oee|efficiency)\b/i.test(lowerMsg);
    const wantsHourly = /\b(hour|hourly)\b/i.test(lowerMsg);
    const wantsBrandByMonth = /\b(lux|lifebuoy|brand)\b/i.test(lowerMsg) && /\b(month|monthly)\b/i.test(lowerMsg);
    const wantsBrand = /\b(brand|lux vs|lifebuoy)\b/i.test(lowerMsg) && !/\b(all variant|each variant)\b/i.test(lowerMsg);
    const isPie = /\b(pie|doughnut|donut)\b/i.test(lowerMsg);
    const isLine = /\b(line|trend)\b/i.test(lowerMsg);

    const palette = [
        "#0d9488", "#4f46e5", "#0284c7", "#10b981", "#f59e0b",
        "#e11d48", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
        "#f97316", "#6366f1"
    ];

    // Special Case 1: Multi-Dataset Grouped Bar Chart (LUX vs Lifebuoy by Month)
    if (wantsBrandByMonth) {
        const monthKeys = Object.keys(globalMonthly);
        const luxData = monthKeys.map(m => wantsTons ? (globalMonthly[m].lux_tons || 0) : (globalMonthly[m].lux_cases || 0));
        const lbData = monthKeys.map(m => wantsTons ? (globalMonthly[m].lifebuoy_tons || 0) : (globalMonthly[m].lifebuoy_cases || 0));
        const chartTitle = `Monthly Brand Comparison — LUX vs. Lifebuoy (${wantsTons ? "Tons" : "Cases"})`;

        const multiConfig = {
            type: "bar",
            data: {
                labels: monthKeys,
                datasets: [
                    { label: `LUX (${wantsTons ? "Tons" : "Cases"})`, data: luxData, backgroundColor: "#0d9488", borderRadius: 6 },
                    { label: `Lifebuoy (${wantsTons ? "Tons" : "Cases"})`, data: lbData, backgroundColor: "#4f46e5", borderRadius: 6 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, position: "bottom" },
                    title: { display: true, text: chartTitle, font: { size: 14, weight: "bold" } }
                },
                scales: { y: { beginAtZero: true } }
            }
        };
        return "```json\n" + JSON.stringify(multiConfig) + "\n```\n📊 **" + chartTitle + "**";
    }

    let labels = [];
    let dataValues = [];
    let datasetLabel = "";
    let chartTitle = "";

    // Special Case 2: Hourly Production Chart
    if (wantsHourly && Object.keys(stats.hourly_totals).length > 0) {
        const sortedHours = Object.entries(stats.hourly_totals).sort(([a], [b]) => a.localeCompare(b));
        labels = sortedHours.map(([h]) => h);
        dataValues = sortedHours.map(([, c]) => c);
        datasetLabel = "Cases Produced";
        chartTitle = `${filterLabel} — Hourly Production (Cases)`;
    }
    // 3. Brand Split Chart
    else if (wantsBrand && Object.keys(stats.brands).length > 0) {
        const sortedBrands = Object.entries(stats.brands)
            .sort((a, b) => (wantsTons ? b[1].tons - a[1].tons : b[1].cases - a[1].cases));
        labels = sortedBrands.map(([b]) => b);
        dataValues = sortedBrands.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Tons Produced" : "Cases Produced";
        chartTitle = `${filterLabel} — Brand Split (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 4. Variant Breakdown Chart
    else if (/(variant|sku|product|across all|what we produced)/i.test(lowerMsg) && Object.keys(stats.variants).length > 0) {
        const sortedVariants = Object.entries(stats.variants)
            .sort((a, b) => (wantsTons ? b[1].tons - a[1].tons : b[1].cases - a[1].cases));

        labels = sortedVariants.map(([v]) => v);
        dataValues = sortedVariants.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Tons Produced" : "Cases Produced";
        chartTitle = `${filterLabel} — Production by Variant (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 5. Monthly Rollup Chart
    else if (/\b(monthly|by month|each month|months)\b/i.test(lowerMsg)) {
        const monthEntries = Object.entries(globalMonthly);
        labels = monthEntries.map(([m]) => m);
        dataValues = monthEntries.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Monthly Tons" : "Monthly Cases";
        chartTitle = `Monthly Production (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 6. Shift-by-Shift Chart
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

    const summaryLine = `📊 **${chartTitle}**\n• **Total Output:** ${stats.total_cases.toLocaleString()} cases (**${stats.total_tons.toFixed(2)} tons**)\n• **Shifts Included:** ${stats.shift_count} shifts`;
    return "```json\n" + JSON.stringify(chartConfig) + "\n```\n" + summaryLine;
}

// Neat, Bulleted Executive Card Responder
function buildFocusedJSReply(lowerMsg, filterLabel, stats, allShifts, matchedMonths, targetYear) {
    if (stats.shift_count === 0) {
        if (matchedMonths && matchedMonths.length === 1) {
            const monthShifts = allShifts.filter(s => s.month === matchedMonths[0] && (!targetYear || s.year === targetYear));
            if (monthShifts.length > 0) {
                const availableDates = [...new Set(monthShifts.map(s => s.date))].join(", ");
                return `⚠️ **No Shift Recorded on ${filterLabel}**\n\n📅 **Available Dates in ${MONTH_NAMES[matchedMonths[0]]}:**\n• ${availableDates}`;
            }
        }
        return `⚠️ No production shift records were found for **${filterLabel}**.`;
    }

    const asksBestOrWorst = /\b(best|highest|most|top|worst|lowest|least|record|peak)\b/i.test(lowerMsg);
    const asksBrandSplit = /\b(lux|lifebuoy|brand)\b/i.test(lowerMsg) && /\b(split|vs|compare|production|total|cases|tons)\b/i.test(lowerMsg);
    const asksDowntime = /(breakdown|downtime|stoppage|stopped|fault|changeover|break)/i.test(lowerMsg);
    const asksTonsOnly = /(ton|tonnage|weight)/i.test(lowerMsg) && !/(case|variant|sku|what we produced|breakdown|lux|lifebuoy)/i.test(lowerMsg);
    const asksCasesOnly = /\b(case|cases|boxes)\b/i.test(lowerMsg) && !/(ton|variant|sku|what we produced|breakdown|lux|lifebuoy)/i.test(lowerMsg);
    const asksOeeOnly = /\b(oee|efficiency|target)\b/i.test(lowerMsg);

    const unreportedNote = stats.unreported_count > 0
        ? `\n• *⚠️ Note: ${stats.unreported_count} automated shift(${stats.unreported_cases.toLocaleString()} cases) does not have a generated OEE/tonnage report yet.*`
        : "";

    const legacyNote = stats.legacy_count > 0
        ? `\n\n*ℹ️ Includes ${stats.legacy_count} legacy manual record${stats.legacy_count > 1 ? "s" : ""} (no automated breakdown timing).*`
        : "";

    if (asksBestOrWorst && stats.records.best_cases) {
        const r = stats.records;
        return `🏆 **Shift Records — ${filterLabel} (${stats.shift_count} Shifts)**\n` +
            `• **Highest Production:** **${r.best_cases.date}** — **${r.best_cases.cases.toLocaleString()} cases** (${r.best_cases.tons.toFixed(2)} tons)\n` +
            `• **Lowest Production:** **${r.lowest_cases.date}** — **${r.lowest_cases.cases.toLocaleString()} cases** (${r.lowest_cases.tons.toFixed(2)} tons)\n` +
            (r.best_oee ? `• **Best OEE:** **${r.best_oee.date}** — **${r.best_oee.oee.toFixed(2)}%**\n` : "") +
            (r.worst_downtime && r.worst_downtime.downtime_mins > 0 ? `• **Highest Downtime:** **${r.worst_downtime.date}** — **${r.worst_downtime.downtime_mins} mins** (${r.worst_downtime.breakdown_count} stops)\n` : "") +
            (stats.peak_hour ? `• **Peak Production Hour:** **${stats.peak_hour.hour}** (${stats.peak_hour.cases.toLocaleString()} cases)` : "");
    }

    if (asksBrandSplit && Object.keys(stats.brands).length > 0) {
        const brandBullets = Object.entries(stats.brands)
            .sort((a, b) => b[1].cases - a[1].cases)
            .map(([bName, d]) => `• **${bName}:** **${d.cases.toLocaleString()} cases** (**${d.tons.toFixed(2)} tons** — ${d.share_pct}%)`)
            .join("\n");
        return `📊 **Brand Split — ${filterLabel} (${stats.shift_count} Shifts)**\n${brandBullets}\n• **Combined Total:** ${stats.total_cases.toLocaleString()} cases (${stats.total_tons.toFixed(2)} tons)${unreportedNote}`;
    }

    if (asksDowntime) {
        if (stats.legacy_count === stats.shift_count) {
            return `⏱️ **${filterLabel} — Downtime Report**\n• **Recorded Breakdown Time:** 0 mins\n• **Note:** All **${stats.shift_count} shifts** in this period are *legacy manual entries*, which do not store automated breakdown logs.`;
        }
        return `⏱️ **${filterLabel} — Stoppage & Downtime Summary**\n• **True Breakdown Time:** **${stats.total_downtime_mins} mins** (${(stats.total_downtime_mins / 60).toFixed(1)} hrs across ${stats.total_breakdowns} stops)\n• **Changeover Time:** **${stats.total_changeover_mins} mins** (${stats.total_changeover_count} changeovers)\n• **Break Time:** **${stats.total_break_mins} mins**${legacyNote}`;
    }

    if (asksTonsOnly) {
        return `⚖️ **${filterLabel} — Total Tonnage**\n• **Total Weight:** **${stats.total_tons.toFixed(2)} tons**\n• **Total Cases:** ${stats.total_cases.toLocaleString()} cases *(across ${stats.shift_count} shifts)*${unreportedNote}`;
    }

    if (asksCasesOnly) {
        return `📦 **${filterLabel} — Total Cases**\n• **Total Output:** **${stats.total_cases.toLocaleString()} cases**\n• **Total Weight:** ${stats.total_tons.toFixed(2)} tons *(across ${stats.shift_count} shifts)*${unreportedNote}`;
    }

    if (asksOeeOnly) {
        return stats.avg_oee !== null
            ? `📈 **${filterLabel} — Efficiency (OEE)**\n• **Average OEE:** **${stats.avg_oee}%**\n• **Output:** ${stats.total_cases.toLocaleString()} cases (${stats.total_tons.toFixed(2)} tons across ${stats.shift_count} shifts)`
            : `ℹ️ No OEE percentage was calculated for **${filterLabel}**.`;
    }

    const brandSummary = Object.entries(stats.brands)
        .sort((a, b) => b[1].cases - a[1].cases)
        .map(([bName, d]) => `• **${bName} Total:** ${d.cases.toLocaleString()} cases *(${d.tons.toFixed(2)} t — ${d.share_pct}%)*`)
        .join("\n");

    const variantBullets = Object.entries(stats.variants)
        .sort((a, b) => b[1].cases - a[1].cases)
        .map(([v, d]) => `• **${v}:** ${d.cases.toLocaleString()} cases *(${d.tons.toFixed(2)} t)*`)
        .join("\n");

    return `📊 **${filterLabel} — Production Summary**\n• **Total Output:** **${stats.total_cases.toLocaleString()} cases** (**${stats.total_tons.toFixed(2)} tons**)\n• **Shifts Logged:** ${stats.shift_count} shift${stats.shift_count > 1 ? "s" : ""}${stats.avg_oee ? ` | **Avg OEE:** **${stats.avg_oee}%**` : ""}\n• **True Downtime:** ${stats.total_downtime_mins} mins | **Changeovers:** ${stats.total_changeover_mins} mins${unreportedNote}${brandSummary ? `\n\n🏷️ **Split by Brand:**\n${brandSummary}` : ""}${variantBullets ? `\n\n📦 **Breakdown by Variant:**\n${variantBullets}` : ""}${legacyNote}`;
}

exports.handler = async function(event, context) {
    context.callbackWaitsForEmptyEventLoop = false;

    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const message = (body.message || "").trim();
        const chatHistory = Array.isArray(body.history) ? body.history.slice(-6) : [];

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

        // 2. Instant Greeting Handler
        if (/^(hi|hello|hey|salam|good morning|good evening|help)[\s!?.]*$/i.test(lowerMsg)) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reply: `👋 **Hello! I'm your Factory AI Analyst.**\n\n🟢 **Live Line Status:** **${liveStatusStr}** (${liveCasesNow.toLocaleString()} cases)\n\n💡 **Try asking me:**\n• *"Tell me production split in LUX and Lifebuoy"*\n• *"Production from 5 September to 20 September"*\n• *"Which shift had the highest production in 2026?"*\n• *"Make a chart comparing LUX vs Lifebuoy by month"*`
                })
            };
        }

        // 3. Normalize all shift records (including hourly_production, changeovers, breaks, and breakdowns)
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
                const changeovers = (r && Array.isArray(r.changeovers)) ? r.changeovers : [];
                const breaks = (r && Array.isArray(r.breaks)) ? r.breaks : [];
                const breakdowns = Array.isArray(s.breakdowns) ? s.breakdowns : [];
                const hourly = (s.hourly_production && typeof s.hourly_production === "object") ? s.hourly_production : {};

                const formattedDate = s.date || s.shift_date || (d ? `${String(d.day).padStart(2, "0")}-${String(d.month + 1).padStart(2, "0")}-${d.year}` : "Unknown");

                return {
                    date: formattedDate,
                    day: d ? d.day : null,
                    month: d ? d.month : null,
                    year: d ? d.year : null,
                    dayValue: d ? d.dayValue : 0,
                    shift_start_str: formatQatarTime(s.shift_start),
                    shift_end_str: formatQatarTime(s.shift_end),
                    cases,
                    tons,
                    oee,
                    has_report: !!r,
                    source: s.source === "legacy_manual" ? "legacy_manual" : "automated",
                    downtime_mins: Math.round(trueDowntimeSec / 60),
                    changeover_mins: Math.round(changeoverSec / 60),
                    changeover_count: changeovers.length,
                    break_mins: Math.round(breakSec / 60),
                    breakdown_count: Number((r && r.true_breakdown_count) ?? s.breakdown_count ?? 0),
                    variant_totals: variantTotals,
                    variant_tons: variantTons,
                    hourly_production: hourly,
                    changeovers_detail: changeovers.map(c => ({ time: formatQatarTime(c.start), to: c.to, mins: Math.round((c.duration || 0) / 60) })),
                    breakdowns_detail: breakdowns.map(b => ({ time: formatQatarTime(b.start), mins: Math.round((b.duration || 0) / 60) })),
                    breaks_detail: breaks.map(b => ({ time: formatQatarTime(b.start), mins: Math.round((b.duration || 0) / 60) }))
                };
            });

        // 4. SMART JS FILTER WITH CONVERSATIONAL MEMORY INHERITANCE
        const nowQatar = new Date(Date.now() + (3 * 3600 * 1000));
        const currentYear = nowQatar.getUTCFullYear();
        const currentMonth = nowQatar.getUTCMonth();

        let activeFilter = extractTimeFilter(lowerMsg, allShifts, currentYear, currentMonth);

        // If current message has no explicit timeframe and looks like a follow-up ("make a pie chart of that", "what about breakdown?"), inherit from previous user message
        if (activeFilter.type === "none" && chatHistory.length > 0) {
            const isFollowUp = /\b(that|those|it|there|same|also|what about|how about|and in|chart|graph|plot|pie|bar|line|breakdown|downtime|oee|variant|lux|lifebuoy)\b/i.test(lowerMsg);
            if (isFollowUp) {
                for (let i = chatHistory.length - 1; i >= 0; i--) {
                    if (chatHistory[i].role === "user") {
                        const prevFilter = extractTimeFilter(chatHistory[i].content, allShifts, currentYear, currentMonth);
                        if (prevFilter.type !== "none") {
                            activeFilter = prevFilter;
                            break;
                        }
                    }
                }
            }
        }

        let filteredShifts = allShifts;
        let filterLabel = "All Recorded History";
        let matchedMonths = [];
        let targetYear = null;

        if (activeFilter.type === "range") {
            filteredShifts = allShifts.filter(s => s.dayValue >= activeFilter.range.startVal && s.dayValue <= activeFilter.range.endVal);
            filterLabel = activeFilter.range.label;
        } else if (activeFilter.type === "calendar") {
            matchedMonths = activeFilter.matchedMonths;
            targetYear = activeFilter.requestedYear;

            if (targetYear) {
                filteredShifts = filteredShifts.filter(s => s.year === targetYear);
                filterLabel = `Year ${targetYear}`;
            }

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

                if (activeFilter.requestedDay !== null) {
                    filteredShifts = filteredShifts.filter(s => s.day === activeFilter.requestedDay);
                    filterLabel = `${activeFilter.requestedDay} ${MONTH_NAMES[matchedMonths[0]]}${targetYear ? " " + targetYear : ""}`;
                } else {
                    filterLabel = `${matchedMonths.map(m => MONTH_NAMES[m]).join(", ")}${targetYear ? " " + targetYear : ""}`;
                }
            }
        } else if (activeFilter.type === "slice") {
            filteredShifts = allShifts.slice(-activeFilter.count);
            filterLabel = activeFilter.label;
        }

        // 5. Complete JS Mathematical Aggregator (Totals, Brands, Variants, Hourly, Changeovers, Best/Worst Records)
        function aggregateShifts(shiftsArray) {
            let totalCases = 0, totalTons = 0, totalDowntimeMins = 0, totalChangeoverMins = 0, totalChangeoverCount = 0;
            let totalBreakMins = 0, totalBreakdowns = 0, oeeSum = 0, oeeCount = 0, legacyCount = 0;
            let unreportedCount = 0, unreportedCases = 0;
            const byVariant = {};
            const byBrand = {};
            const byMonth = {};
            const hourlyTotals = {};

            let bestCasesShift = null, lowestCasesShift = null;
            let bestOeeShift = null, worstOeeShift = null;
            let worstDowntimeShift = null;

            shiftsArray.forEach(s => {
                totalCases += s.cases;
                totalTons += s.tons;
                totalDowntimeMins += s.downtime_mins;
                totalChangeoverMins += s.changeover_mins;
                totalChangeoverCount += s.changeover_count;
                totalBreakMins += s.break_mins;
                totalBreakdowns += s.breakdown_count;

                if (s.source === "legacy_manual") legacyCount++;
                if (!s.has_report && s.source !== "legacy_manual") {
                    unreportedCount++;
                    unreportedCases += s.cases;
                }

                if (s.oee !== null && s.oee > 0) {
                    oeeSum += s.oee;
                    oeeCount++;
                    if (!bestOeeShift || s.oee > bestOeeShift.oee) bestOeeShift = { date: s.date, oee: Number(s.oee.toFixed(2)), cases: s.cases, tons: Number(s.tons.toFixed(2)) };
                    if (!worstOeeShift || s.oee < worstOeeShift.oee) worstOeeShift = { date: s.date, oee: Number(s.oee.toFixed(2)), cases: s.cases, tons: Number(s.tons.toFixed(2)) };
                }

                if (!bestCasesShift || s.cases > bestCasesShift.cases) bestCasesShift = { date: s.date, cases: s.cases, tons: Number(s.tons.toFixed(2)), oee: s.oee };
                if (s.cases > 0 && (!lowestCasesShift || s.cases < lowestCasesShift.cases)) lowestCasesShift = { date: s.date, cases: s.cases, tons: Number(s.tons.toFixed(2)), oee: s.oee };
                if (!worstDowntimeShift || s.downtime_mins > worstDowntimeShift.downtime_mins) worstDowntimeShift = { date: s.date, downtime_mins: s.downtime_mins, breakdown_count: s.breakdown_count, cases: s.cases };

                // Aggregate Hourly Production
                Object.entries(s.hourly_production || {}).forEach(([hLabel, hCases]) => {
                    hourlyTotals[hLabel] = (hourlyTotals[hLabel] || 0) + Number(hCases || 0);
                });

                const mKey = (s.year && s.month !== null) ? `${MONTH_NAMES[s.month]} ${s.year}` : "Unknown";
                if (!byMonth[mKey]) {
                    byMonth[mKey] = { shifts: 0, cases: 0, tons: 0, legacy_shifts: 0, lux_cases: 0, lux_tons: 0, lifebuoy_cases: 0, lifebuoy_tons: 0 };
                }
                byMonth[mKey].shifts += 1;
                byMonth[mKey].cases += s.cases;
                byMonth[mKey].tons = Number((byMonth[mKey].tons + s.tons).toFixed(2));
                if (s.source === "legacy_manual") byMonth[mKey].legacy_shifts += 1;

                Object.entries(s.variant_totals || {}).forEach(([vName, vCases]) => {
                    const c = Number(vCases || 0);
                    const t = Number((s.variant_tons && s.variant_tons[vName]) || 0);

                    if (!byVariant[vName]) byVariant[vName] = { cases: 0, tons: 0 };
                    byVariant[vName].cases += c;
                    byVariant[vName].tons = Number((byVariant[vName].tons + t).toFixed(2));

                    const upperV = vName.toUpperCase();
                    const brandName = upperV.includes("LUX") ? "LUX" : (upperV.includes("LIFEBUOY") ? "Lifebuoy" : "Other");
                    if (!byBrand[brandName]) byBrand[brandName] = { cases: 0, tons: 0, share_pct: 0 };
                    byBrand[brandName].cases += c;
                    byBrand[brandName].tons = Number((byBrand[brandName].tons + t).toFixed(2));

                    if (brandName === "LUX") {
                        byMonth[mKey].lux_cases += c;
                        byMonth[mKey].lux_tons = Number((byMonth[mKey].lux_tons + t).toFixed(2));
                    } else if (brandName === "Lifebuoy") {
                        byMonth[mKey].lifebuoy_cases += c;
                        byMonth[mKey].lifebuoy_tons = Number((byMonth[mKey].lifebuoy_tons + t).toFixed(2));
                    }
                });
            });

            Object.keys(byBrand).forEach(b => {
                byBrand[b].share_pct = totalCases > 0 ? Number(((byBrand[b].cases / totalCases) * 100).toFixed(1)) : 0;
            });

            let peakHour = null;
            Object.entries(hourlyTotals).forEach(([hour, cases]) => {
                if (!peakHour || cases > peakHour.cases) peakHour = { hour, cases };
            });

            return {
                shift_count: shiftsArray.length,
                legacy_count: legacyCount,
                automated_count: shiftsArray.length - legacyCount,
                unreported_count: unreportedCount,
                unreported_cases: unreportedCases,
                total_cases: totalCases,
                total_tons: Number(totalTons.toFixed(2)),
                avg_oee: oeeCount > 0 ? Number((oeeSum / oeeCount).toFixed(2)) : null,
                total_downtime_mins: totalDowntimeMins,
                total_changeover_mins: totalChangeoverMins,
                total_changeover_count: totalChangeoverCount,
                total_break_mins: totalBreakMins,
                total_breakdowns: totalBreakdowns,
                brands: byBrand,
                variants: byVariant,
                hourly_totals: hourlyTotals,
                peak_hour: peakHour,
                records: {
                    best_cases: bestCasesShift,
                    lowest_cases: lowestCasesShift,
                    best_oee: bestOeeShift,
                    worst_oee: worstOeeShift,
                    worst_downtime: worstDowntimeShift
                },
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

        // 7. Build Granular Shift Payload (Include full hourly/stoppage details when <= 5 shifts are selected)
        const isSmallSlice = filteredShifts.length <= 5;
        const compactRows = filteredShifts.slice(-25).map(s => {
            const base = {
                date: s.date,
                shift_time: `${s.shift_start_str} - ${s.shift_end_str}`,
                cases: s.cases,
                tons: Number(s.tons.toFixed(2)),
                oee: s.oee !== null ? Number(s.oee.toFixed(1)) : null,
                downtime_mins: s.downtime_mins,
                changeover_mins: s.changeover_mins,
                break_mins: s.break_mins,
                source: s.source,
                report_ready: s.has_report,
                variants: s.variant_totals
            };
            if (isSmallSlice) {
                base.hourly_production = s.hourly_production;
                base.changeovers = s.changeovers_detail;
                base.breakdowns = s.breakdowns_detail;
                base.breaks = s.breaks_detail;
            }
            return base;
        });

        const systemPrompt = `You are the Factory AI Analyst for a Unilever production line.

LIVE ACTIVE SHIFT RIGHT NOW:
Status: ${liveStatusStr}, Live Cases: ${liveCasesNow.toLocaleString()}, Breakdown: ${Math.round(Number((liveData && liveData.breakdown_seconds) || 0) / 60)} mins.

VERIFIED JS-CALCULATED TOTALS FOR "${filterLabel}" (${stats.shift_count} Shifts):
- Matched Shifts: ${stats.shift_count} (${stats.automated_count} automated, ${stats.legacy_count} legacy_manual, ${stats.unreported_count} awaiting OEE/tonnage report)
- Total Cases Produced: ${stats.total_cases.toLocaleString()} cases
- Total Tonnage: ${stats.total_tons.toFixed(2)} tons
- Average OEE: ${stats.avg_oee !== null ? stats.avg_oee + "%" : "N/A"}
- Total True Downtime: ${stats.total_downtime_mins} mins (${(stats.total_downtime_mins / 60).toFixed(1)} hrs) across ${stats.total_breakdowns} breakdowns
- Total Changeovers: ${stats.total_changeover_count} changeovers (${stats.total_changeover_mins} mins total)
- Total Break Time: ${stats.total_break_mins} mins
- Peak Production Hour Bucket: ${stats.peak_hour ? `${stats.peak_hour.hour} (${stats.peak_hour.cases.toLocaleString()} cases)` : "N/A"}
- Hourly Production Totals: ${JSON.stringify(stats.hourly_totals)}
- ALL-SHIFT RECORDS (BEST / WORST IN PERIOD): ${JSON.stringify(stats.records)}
- PRE-CALCULATED BRAND SPLIT (LUX vs Lifebuoy): ${JSON.stringify(stats.brands)}
- Production by Individual Variant: ${JSON.stringify(stats.variants)}

ALL-TIME MONTHLY ROLLUP:
${JSON.stringify(globalMonthly)}

SHIFT RECORDS FOR "${filterLabel}":
${JSON.stringify(compactRows)}

STRICT VISUAL FORMATTING & MATH RULES (CRITICAL):
1. ALWAYS use the VERIFIED JS-CALCULATED TOTALS, ALL-SHIFT RECORDS, and PRE-CALCULATED BRAND SPLIT above. NEVER manually add numbers yourself.
2. Always include the timeframe ("${filterLabel}" and "${stats.shift_count} shifts") in your bold header.
3. Format your response like a clean executive card:
   - Start with a bold title line and a relevant emoji.
   - Put each key metric, brand, or variant on its own separate line starting with "• " and bold the label/numbers.
   - NEVER use ### headings or Markdown |---| tables.
4. Answer ONLY what the user asked concisely. If ${stats.unreported_count} > 0 and the user asks about tonnage/OEE, mention that ${stats.unreported_count} automated shift(s) (${stats.unreported_cases} cases) do not have a saved OEE/tonnage report yet.`;

        let replyText = "";

        // 8. PRIMARY ENGINE: Groq Active Production Models (with conversational memory)
        const groqKey = (process.env.GROQ_API_KEY || "").trim();
        if (groqKey) {
            const groqModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
            const messagesPayload = [
                { role: "system", content: systemPrompt },
                ...chatHistory.map(m => ({
                    role: m.role === "assistant" ? "assistant" : "user",
                    content: String(m.content || "").slice(0, 600)
                })),
                { role: "user", content: message }
            ];

            for (const gModel of groqModels) {
                if (replyText) break;
                try {
                    const reqBody = {
                        model: gModel,
                        messages: messagesPayload,
                        temperature: 0.1,
                        max_completion_tokens: 2048
                    };

                    if (gModel.startsWith("openai/gpt-oss")) {
                        reqBody.reasoning_effort = "low";
                    }

                    const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${groqKey}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify(reqBody)
                    }, 4500);

                    if (groqRes.ok) {
                        const groqData = await groqRes.json();
                        replyText = formatForChatUI(groqData.choices?.[0]?.message?.content);
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
