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

// Instant Native JS Chart.js Builder (Supports Brand Split, Variant Split, Monthly, and Daily Charts)
function buildNativeChartReply(lowerMsg, filterLabel, stats, filteredShifts, globalMonthly) {
    const wantsTons = /\b(ton|tons|tonnage)\b/i.test(lowerMsg) && !/\b(case|cases)\b/i.test(lowerMsg);
    const wantsDowntime = /\b(downtime|breakdown|stoppage)\b/i.test(lowerMsg);
    const wantsOee = /\b(oee|efficiency)\b/i.test(lowerMsg);
    const wantsBrand = /\b(brand|lux vs|lifebuoy)\b/i.test(lowerMsg) && !/\b(all variant|each variant)\b/i.test(lowerMsg);
    const isPie = /\b(pie|doughnut|donut|split)\b/i.test(lowerMsg);
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

    // 1. Brand Split Chart (LUX vs Lifebuoy)
    if (wantsBrand && Object.keys(stats.brands).length > 0) {
        const sortedBrands = Object.entries(stats.brands)
            .sort((a, b) => (wantsTons ? b[1].tons - a[1].tons : b[1].cases - a[1].cases));
        labels = sortedBrands.map(([b]) => b);
        dataValues = sortedBrands.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Tons Produced" : "Cases Produced";
        chartTitle = `${filterLabel} — Brand Split (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 2. Variant Breakdown Chart
    else if (/(variant|sku|product|across all|what we produced)/i.test(lowerMsg) && Object.keys(stats.variants).length > 0) {
        const sortedVariants = Object.entries(stats.variants)
            .sort((a, b) => (wantsTons ? b[1].tons - a[1].tons : b[1].cases - a[1].cases));

        labels = sortedVariants.map(([v]) => v);
        dataValues = sortedVariants.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Tons Produced" : "Cases Produced";
        chartTitle = `${filterLabel} — Production by Variant (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 3. Monthly Rollup Chart
    else if (/\b(monthly|by month|each month|months)\b/i.test(lowerMsg)) {
        const monthEntries = Object.entries(globalMonthly);
        labels = monthEntries.map(([m]) => m);
        dataValues = monthEntries.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Monthly Tons" : "Monthly Cases";
        chartTitle = `Monthly Production (${wantsTons ? "Tons" : "Cases"})`;
    }
    // 4. Shift-by-Shift Chart
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
        if (matchedMonths.length === 1) {
            const monthShifts = allShifts.filter(s => s.month === matchedMonths[0] && (!targetYear || s.year === targetYear));
            if (monthShifts.length > 0) {
                const availableDates = [...new Set(monthShifts.map(s => s.date))].join(", ");
                return `⚠️ **No Shift Recorded on ${filterLabel}**\n\n📅 **Available Dates in ${MONTH_NAMES[matchedMonths[0]]}:**\n• ${availableDates}`;
            }
        }
        return `⚠️ No production shift records were found for **${filterLabel}**.`;
    }

    const asksBrandSplit = /\b(lux|lifebuoy|brand)\b/i.test(lowerMsg) && /\b(split|vs|compare|production|total|cases|tons)\b/i.test(lowerMsg);
    const asksDowntime = /(breakdown|downtime|stoppage|stopped|fault|changeover)/i.test(lowerMsg);
    const asksTonsOnly = /(ton|tonnage|weight)/i.test(lowerMsg) && !/(case|variant|sku|what we produced|breakdown|lux|lifebuoy)/i.test(lowerMsg);
    const asksCasesOnly = /\b(case|cases|boxes)\b/i.test(lowerMsg) && !/(ton|variant|sku|what we produced|breakdown|lux|lifebuoy)/i.test(lowerMsg);
    const asksOeeOnly = /\b(oee|efficiency|target)\b/i.test(lowerMsg);

    const legacyNote = stats.legacy_count > 0
        ? `\n\n*ℹ️ Includes ${stats.legacy_count} legacy manual record${stats.legacy_count > 1 ? "s" : ""} (no automated breakdown timing).*`
        : "";

    if (asksBrandSplit && Object.keys(stats.brands).length > 0) {
        const brandBullets = Object.entries(stats.brands)
            .sort((a, b) => b[1].cases - a[1].cases)
            .map(([bName, d]) => `• **${bName}:** **${d.cases.toLocaleString()} cases** (**${d.tons.toFixed(2)} tons** — ${d.share_pct}%)`)
            .join("\n");
        return `📊 **Brand Split — ${filterLabel} (${stats.shift_count} Shifts)**\n${brandBullets}\n• **Combined Total:** ${stats.total_cases.toLocaleString()} cases (${stats.total_tons.toFixed(2)} tons)`;
    }

    if (asksDowntime) {
        if (stats.legacy_count === stats.shift_count) {
            return `⏱️ **${filterLabel} — Downtime Report**\n• **Recorded Breakdown Time:** 0 mins\n• **Note:** All **${stats.shift_count} shifts** in this period are *legacy manual entries*, which do not store automated breakdown logs.`;
        }
        return `⏱️ **${filterLabel} — Downtime Summary**\n• **True Breakdown Time:** **${stats.total_downtime_mins} mins** (${(stats.total_downtime_mins / 60).toFixed(1)} hrs)\n• **Breakdown Events:** ${stats.total_breakdowns} stops\n• **Changeover Time:** ${stats.total_changeover_mins} mins${legacyNote}`;
    }

    if (asksTonsOnly) {
        return `⚖️ **${filterLabel} — Total Tonnage**\n• **Total Weight:** **${stats.total_tons.toFixed(2)} tons**\n• **Total Cases:** ${stats.total_cases.toLocaleString()} cases *(across ${stats.shift_count} shifts)*`;
    }

    if (asksCasesOnly) {
        return `📦 **${filterLabel} — Total Cases**\n• **Total Output:** **${stats.total_cases.toLocaleString()} cases**\n• **Total Weight:** ${stats.total_tons.toFixed(2)} tons *(across ${stats.shift_count} shifts)*`;
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

    return `📊 **${filterLabel} — Production Summary**\n• **Total Output:** **${stats.total_cases.toLocaleString()} cases** (**${stats.total_tons.toFixed(2)} tons**)\n• **Shifts Logged:** ${stats.shift_count} shift${stats.shift_count > 1 ? "s" : ""}${stats.avg_oee ? ` | **Avg OEE:** **${stats.avg_oee}%**` : ""}\n• **True Downtime:** ${stats.total_downtime_mins} mins${brandSummary ? `\n\n🏷️ **Split by Brand:**\n${brandSummary}` : ""}${variantBullets ? `\n\n📦 **Breakdown by Variant:**\n${variantBullets}` : ""}${legacyNote}`;
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

        // 2. Instant Greeting Handler
        if (/^(hi|hello|hey|salam|good morning|good evening|help)[\s!?.]*$/i.test(lowerMsg)) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    reply: `👋 **Hello! I'm your Factory AI Analyst.**\n\n🟢 **Live Line Status:** **${liveStatusStr}** (${liveCasesNow.toLocaleString()} cases)\n\n💡 **Try asking me:**\n• *"Tell me production split in LUX and Lifebuoy"*\n• *"Make a graph of variants in September"*\n• *"How many total tons till now?"*\n• *"What we produced on 30 September?"*`
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

        // 4. SMART JS FILTER: Specific Date, Month, Year, or Default to ALL Recorded History
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

        // DEFAULT TO ALL RECORDED SHIFTS unless a specific date/month/recent slice is requested
        let filteredShifts = allShifts;
        let filterLabel = "All Recorded History";
        let targetYear = requestedYear;

        if (requestedYear) {
            filteredShifts = filteredShifts.filter(s => s.year === requestedYear);
            filterLabel = `Year ${requestedYear}`;
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

            if (requestedDay !== null) {
                filteredShifts = filteredShifts.filter(s => s.day === requestedDay);
                filterLabel = `${requestedDay} ${MONTH_NAMES[matchedMonths[0]]}${targetYear ? " " + targetYear : ""}`;
            } else {
                filterLabel = `${matchedMonths.map(m => MONTH_NAMES[m]).join(", ")}${targetYear ? " " + targetYear : ""}`;
            }
        } else if (lowerMsg.includes("last 30") || lowerMsg.includes("recent 30")) {
            filteredShifts = allShifts.slice(-30);
            filterLabel = "Latest 30 Shifts";
        } else if (lowerMsg.includes("last 7") || lowerMsg.includes("last week") || lowerMsg.includes("past week")) {
            filteredShifts = allShifts.slice(-7);
            filterLabel = "Last 7 Shifts";
        } else if (lowerMsg.includes("last shift") || lowerMsg.includes("latest shift") || lowerMsg.includes("yesterday")) {
            filteredShifts = allShifts.slice(-1);
            filterLabel = "Latest Shift";
        }

        // 5. Exact JS Mathematical Aggregator (Includes Pre-Calculated Brand Split: LUX vs Lifebuoy)
        function aggregateShifts(shiftsArray) {
            let totalCases = 0, totalTons = 0, totalDowntimeMins = 0, totalChangeoverMins = 0, totalBreakdowns = 0;
            let oeeSum = 0, oeeCount = 0, legacyCount = 0;
            const byVariant = {};
            const byBrand = {};
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
                    const c = Number(vCases || 0);
                    const t = Number((s.variant_tons && s.variant_tons[vName]) || 0);

                    if (!byVariant[vName]) byVariant[vName] = { cases: 0, tons: 0 };
                    byVariant[vName].cases += c;
                    byVariant[vName].tons = Number((byVariant[vName].tons + t).toFixed(2));

                    // Group by Brand (LUX, Lifebuoy, or Other) in JS so AI never has to add variants
                    const upperV = vName.toUpperCase();
                    const brandName = upperV.includes("LUX") ? "LUX" : (upperV.includes("LIFEBUOY") ? "Lifebuoy" : "Other");
                    if (!byBrand[brandName]) byBrand[brandName] = { cases: 0, tons: 0, share_pct: 0 };
                    byBrand[brandName].cases += c;
                    byBrand[brandName].tons = Number((byBrand[brandName].tons + t).toFixed(2));
                });

                const mKey = (s.year && s.month !== null) ? `${MONTH_NAMES[s.month]} ${s.year}` : "Unknown";
                if (!byMonth[mKey]) byMonth[mKey] = { shifts: 0, cases: 0, tons: 0, legacy_shifts: 0 };
                byMonth[mKey].shifts += 1;
                byMonth[mKey].cases += s.cases;
                byMonth[mKey].tons = Number((byMonth[mKey].tons + s.tons).toFixed(2));
                if (s.source === "legacy_manual") byMonth[mKey].legacy_shifts += 1;
            });

            // Calculate exact brand share percentage
            Object.keys(byBrand).forEach(b => {
                byBrand[b].share_pct = totalCases > 0 ? Number(((byBrand[b].cases / totalCases) * 100).toFixed(1)) : 0;
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
                brands: byBrand,
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

        // 7. System Prompt with Pre-Calculated Brand Split & Clean Visual Formatting Rules
        const compactRows = filteredShifts.slice(-25).map(s => ({
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

VERIFIED JS-CALCULATED TOTALS FOR "${filterLabel}" (${stats.shift_count} Shifts):
- Matched Shifts: ${stats.shift_count} (${stats.automated_count} automated, ${stats.legacy_count} legacy_manual)
- Total Cases Produced: ${stats.total_cases.toLocaleString()} cases
- Total Tonnage: ${stats.total_tons.toFixed(2)} tons
- Average OEE: ${stats.avg_oee !== null ? stats.avg_oee + "%" : "N/A"}
- Total True Downtime: ${stats.total_downtime_mins} mins (${(stats.total_downtime_mins / 60).toFixed(1)} hrs) across ${stats.total_breakdowns} breakdowns
- Total Changeover Time: ${stats.total_changeover_mins} mins
- PRE-CALCULATED BRAND SPLIT (LUX vs Lifebuoy): ${JSON.stringify(stats.brands)}
- Production by Individual Variant: ${JSON.stringify(stats.variants)}

ALL-TIME MONTHLY ROLLUP:
${JSON.stringify(globalMonthly)}

RECENT SHIFT SAMPLE FOR "${filterLabel}":
${JSON.stringify(compactRows)}

STRICT VISUAL FORMATTING & MATH RULES (CRITICAL):
1. ALWAYS use the VERIFIED JS-CALCULATED TOTALS and PRE-CALCULATED BRAND SPLIT above. NEVER manually add variant numbers yourself.
2. Always include the timeframe ("${filterLabel}" and "${stats.shift_count} shifts") in your bold header so the user knows the exact scope.
3. Format your response like a clean executive card:
   - Start with a bold title line and a relevant emoji (e.g., 📊 **Production Split — LUX vs. Lifebuoy (${filterLabel}, ${stats.shift_count} Shifts)**).
   - Put each key metric, brand, or variant on its own separate line starting with "• " and bold the label/numbers.
   - NEVER use ### headings or Markdown |---| tables.
4. Answer ONLY what the user asked concisely.`;

        let replyText = "";

        // 8. PRIMARY ENGINE: Groq Active Production Models
        const groqKey = (process.env.GROQ_API_KEY || "").trim();
        if (groqKey) {
            const groqModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
            for (const gModel of groqModels) {
                if (replyText) break;
                try {
                    const reqBody = {
                        model: gModel,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: message }
                        ],
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
