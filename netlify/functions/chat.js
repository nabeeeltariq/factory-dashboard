const { GoogleGenerativeAI } = require("@google/generative-ai");

const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Converts epoch timestamp into Qatar Time (GMT+3) HH:MM AM/PM
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

// Formats minutes into "X hours Y minutes" if >= 60 mins
function formatDuration(totalMins) {
    const m = Math.round(Number(totalMins) || 0);
    if (m <= 0) return "0 minutes";
    if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
    const hrs = Math.floor(m / 60);
    const rem = m % 60;
    const hrStr = `${hrs} hour${hrs === 1 ? "" : "s"}`;
    return rem > 0 ? `${hrStr} ${rem} minute${rem === 1 ? "" : "s"}` : hrStr;
}

// Splits a variant like "LUX Soft Rose 120GM" into { baseColor: "lux soft rose", sizeGrams: "120GM" }
function parseVariantParts(variantName) {
    const raw = String(variantName || "").trim();
    const match = raw.match(/^(.*?)\s*(\d+\s*(?:gm|g|kg|ml))\b/i);
    if (match) {
        return {
            baseColor: match[1].trim().toLowerCase().replace(/\s+/g, " "),
            sizeGrams: match[2].trim().toUpperCase().replace(/\s+/g, "")
        };
    }
    return {
        baseColor: raw.toLowerCase().replace(/\s+/g, " "),
        sizeGrams: ""
    };
}

// Classifies a changeover between two variants as "color", "mechanical" (size), or "both"
function classifyChangeoverType(fromVariant, toVariant) {
    if (!fromVariant || !toVariant) return "color";
    const fromParts = parseVariantParts(fromVariant);
    const toParts = parseVariantParts(toVariant);

    const colorChanged = fromParts.baseColor !== toParts.baseColor;
    const sizeChanged = fromParts.sizeGrams !== "" && toParts.sizeGrams !== "" && (fromParts.sizeGrams !== toParts.sizeGrams);

    if (colorChanged && sizeChanged) return "both";
    if (!colorChanged && sizeChanged) return "mechanical";
    return "color";
}

// Resolves shift date locked to Qatar Time (GMT+3)
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

// Parses custom "From - To" date ranges
function parseCustomDateRange(text, defaultYear) {
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

    const monthNamesRegex = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
    const textRange = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthNamesRegex})?\\s*(?:to|till|until|\\-|through|and)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthNamesRegex})\\b`, "i");
    const mMatch = text.match(textRange);
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

// Extracts timeframe filter with true Qatar calendar support for "Yesterday" and "Today"
function extractTimeFilter(queryText, allShifts, nowQatar) {
    const lower = (queryText || "").toLowerCase().trim();
    const currentYear = nowQatar.getUTCFullYear();
    const currentMonth = nowQatar.getUTCMonth();
    const currentDay = nowQatar.getUTCDate();

    const availableYears = allShifts.filter(s => s.year).map(s => s.year);
    const latestYearInDb = availableYears.length > 0 ? Math.max(...availableYears) : currentYear;

    // 1. Custom Date Range
    const customRange = parseCustomDateRange(lower, latestYearInDb);
    if (customRange) return { type: "range", range: customRange };

    // 2. True Calendar "Yesterday"
    if (/\byesterday\b/i.test(lower)) {
        const yest = new Date(nowQatar.getTime() - (24 * 3600 * 1000));
        const yDay = yest.getUTCDate();
        const yMonth = yest.getUTCMonth();
        const yYear = yest.getUTCFullYear();
        return {
            type: "calendar",
            matchedMonths: [yMonth],
            requestedDay: yDay,
            requestedYear: yYear,
            customLabel: `${yDay} ${MONTH_NAMES[yMonth]} ${yYear} (Yesterday)`
        };
    }

    // 3. True Calendar "Today" (unless asking "till today")
    if (/\btoday\b/i.test(lower) && !/\b(till|until|up to)\s+today\b/i.test(lower)) {
        return {
            type: "calendar",
            matchedMonths: [currentMonth],
            requestedDay: currentDay,
            requestedYear: currentYear,
            customLabel: `${currentDay} ${MONTH_NAMES[currentMonth]} ${currentYear} (Today)`
        };
    }

    // 4. Explicit Dates / Months / Years
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
        else if (lower.includes("this year") || lower.includes("current year")) requestedYear = currentYear;

        const words = lower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
        words.forEach(w => {
            if (MONTHS[w] !== undefined && !matchedMonths.includes(MONTHS[w])) matchedMonths.push(MONTHS[w]);
        });

        if (matchedMonths.length === 1) {
            const dayPattern = /\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/g;
            let m;
            while ((m = dayPattern.exec(lower)) !== null) {
                const num = Number(m[1]);
                const afterNum = lower.slice(m.index + m[0].length).trim();
                if (!/^(shift|day|week|month|hour|min|ton|case|gm|g\b)/i.test(afterNum)) {
                    requestedDay = num;
                    break;
                }
            }
        }
    }

    if (lower.includes("this month") || lower.includes("current month")) matchedMonths = [currentMonth];
    else if (lower.includes("last month") || lower.includes("previous month")) matchedMonths = [(currentMonth + 11) % 12];

    if (matchedMonths.length > 0 || requestedYear !== null) {
        return { type: "calendar", matchedMonths, requestedDay, requestedYear };
    }

    // 5. Relative Shift Slices
    if (/\b(last 30|recent 30)\b/i.test(lower)) return { type: "slice", count: 30, label: "Latest 30 Shifts" };
    if (/\b(last 7|last week|past week)\b/i.test(lower)) return { type: "slice", count: 7, label: "Last 7 Shifts" };
    if (/\b(last shift|latest shift|last production|latest production|current shift|previous shift|last run|latest run)\b/i.test(lower)) {
        return { type: "slice", count: 1, label: "Latest Recorded Shift" };
    }
    if (/(all time|all shift|history|till now|til now|till today|until today|so far|overall|ever)/i.test(lower)) {
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
        try { JSON.parse(jsonMatch[1].trim()); } catch (e) { text = text.replace(jsonMatch[0], "").trim(); }
    }
    return text.replace(/^#{1,4}\s+(.*)$/gm, "**$1**").replace(/^- /gm, "• ");
}

function buildNativeChartReply(lowerMsg, filterLabel, stats, filteredShifts, globalMonthly) {
    const wantsTons = /\b(ton|tons|tonnage)\b/i.test(lowerMsg) && !/\b(case|cases)\b/i.test(lowerMsg);
    const wantsDowntime = /\b(downtime|breakdown|stoppage)\b/i.test(lowerMsg);
    const wantsOee = /\b(oee|efficiency)\b/i.test(lowerMsg);
    const wantsHourly = /\b(hour|hourly)\b/i.test(lowerMsg);
    const wantsChangeover = /\b(changeover|changeovers|change over)\b/i.test(lowerMsg);
    const wantsBrandByMonth = /\b(lux|lifebuoy|brand)\b/i.test(lowerMsg) && /\b(month|monthly)\b/i.test(lowerMsg);
    const wantsBrand = /\b(brand|lux vs|lifebuoy)\b/i.test(lowerMsg) && !/\b(all variant|each variant)\b/i.test(lowerMsg);
    const isPie = /\b(pie|doughnut|donut)\b/i.test(lowerMsg);
    const isLine = /\b(line|trend)\b/i.test(lowerMsg);

    const palette = ["#0d9488", "#4f46e5", "#0284c7", "#10b981", "#f59e0b", "#e11d48", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1"];

    if (wantsBrandByMonth) {
        const monthKeys = Object.keys(globalMonthly);
        const luxData = monthKeys.map(m => wantsTons ? (globalMonthly[m].lux_tons || 0) : (globalMonthly[m].lux_cases || 0));
        const lbData = monthKeys.map(m => wantsTons ? (globalMonthly[m].lifebuoy_tons || 0) : (globalMonthly[m].lifebuoy_cases || 0));
        const chartTitle = `Monthly Brand Comparison — LUX vs. Lifebuoy (${wantsTons ? "Tons" : "Cases"})`;
        const multiConfig = {
            type: "bar",
            data: { labels: monthKeys, datasets: [ { label: `LUX (${wantsTons ? "Tons" : "Cases"})`, data: luxData, backgroundColor: "#0d9488", borderRadius: 6 }, { label: `Lifebuoy (${wantsTons ? "Tons" : "Cases"})`, data: lbData, backgroundColor: "#4f46e5", borderRadius: 6 } ] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: "bottom" }, title: { display: true, text: chartTitle, font: { size: 14, weight: "bold" } } }, scales: { y: { beginAtZero: true } } }
        };
        return "```json\n" + JSON.stringify(multiConfig) + "\n```\n📊 **" + chartTitle + "**";
    }

    let labels = [], dataValues = [], datasetLabel = "", chartTitle = "";

    if (wantsChangeover) {
        labels = ["Color (Variant Only)", "Mechanical (Size Only)", "Both (Color + Size)"];
        dataValues = [stats.changeovers.color_count, stats.changeovers.mechanical_count, stats.changeovers.both_count];
        datasetLabel = "Changeover Count";
        chartTitle = `${filterLabel} — Changeovers by Type (Total: ${stats.changeovers.total_count})`;
    } else if (wantsHourly && Object.keys(stats.hourly_averages).length > 0) {
        const sortedHours = Object.entries(stats.hourly_averages).sort(([a], [b]) => a.localeCompare(b));
        labels = sortedHours.map(([h]) => h);
        dataValues = sortedHours.map(([, c]) => c);
        datasetLabel = stats.shift_count === 1 ? "Cases Produced" : "Avg Cases / Hour";
        chartTitle = stats.shift_count === 1 ? `${filterLabel} — Hourly Production (Cases)` : `${filterLabel} — Average Hourly Production (Cases/Hr)`;
    } else if (wantsBrand && Object.keys(stats.brands).length > 0) {
        const sortedBrands = Object.entries(stats.brands).sort((a, b) => (wantsTons ? b[1].tons - a[1].tons : b[1].cases - a[1].cases));
        labels = sortedBrands.map(([b]) => b);
        dataValues = sortedBrands.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Tons Produced" : "Cases Produced";
        chartTitle = `${filterLabel} — Brand Split (${wantsTons ? "Tons" : "Cases"})`;
    } else if (/(variant|sku|product|across all|what we produced)/i.test(lowerMsg) && Object.keys(stats.variants).length > 0) {
        const sortedVariants = Object.entries(stats.variants).sort((a, b) => (wantsTons ? b[1].tons - a[1].tons : b[1].cases - a[1].cases));
        labels = sortedVariants.map(([v]) => v);
        dataValues = sortedVariants.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Tons Produced" : "Cases Produced";
        chartTitle = `${filterLabel} — Production by Variant (${wantsTons ? "Tons" : "Cases"})`;
    } else if (/\b(monthly|by month|each month|months)\b/i.test(lowerMsg)) {
        const monthEntries = Object.entries(globalMonthly);
        labels = monthEntries.map(([m]) => m);
        dataValues = monthEntries.map(([, d]) => wantsTons ? d.tons : d.cases);
        datasetLabel = wantsTons ? "Monthly Tons" : "Monthly Cases";
        chartTitle = `Monthly Production (${wantsTons ? "Tons" : "Cases"})`;
    } else {
        const slice = filteredShifts.slice(-30);
        labels = slice.map(s => s.date);
        if (wantsDowntime) { dataValues = slice.map(s => s.downtime_mins); datasetLabel = "Downtime (Mins)"; chartTitle = `${filterLabel} — Downtime per Shift (Mins)`; }
        else if (wantsOee) { dataValues = slice.map(s => s.oee !== null ? Number(s.oee.toFixed(1)) : 0); datasetLabel = "OEE (%)"; chartTitle = `${filterLabel} — OEE % per Shift`; }
        else if (wantsTons) { dataValues = slice.map(s => Number(s.tons.toFixed(2))); datasetLabel = "Tons Produced"; chartTitle = `${filterLabel} — Tonnage per Shift`; }
        else { dataValues = slice.map(s => s.cases); datasetLabel = "Cases Produced"; chartTitle = `${filterLabel} — Cases per Shift`; }
    }

    const chartType = isPie ? "doughnut" : (isLine ? "line" : "bar");
    const chartConfig = {
        type: chartType,
        data: { labels: labels, datasets: [{ label: datasetLabel, data: dataValues, backgroundColor: isPie ? palette.slice(0, labels.length) : (wantsDowntime ? "#e11d48" : "#0d9488"), borderColor: isPie ? "#ffffff" : (wantsDowntime ? "#be123c" : "#0f766e"), borderWidth: 1, borderRadius: chartType === "bar" ? 6 : 0, fill: chartType === "line" ? false : true, tension: 0.3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: isPie, position: "bottom" }, title: { display: true, text: chartTitle, font: { size: 14, weight: "bold" } } }, scales: isPie ? {} : { y: { beginAtZero: true } } }
    };

    return "```json\n" + JSON.stringify(chartConfig) + "\n```\n📊 **" + chartTitle + ":** Total of **" + stats.total_cases.toLocaleString() + " cases** (**" + stats.total_tons.toFixed(2) + " tons**) across **" + stats.shift_count + " shifts**.";
}

function buildFocusedJSReply(lowerMsg, filterLabel, stats, allShifts, matchedMonths, targetYear, firstAutoDateStr) {
    if (stats.shift_count === 0) {
        const latestShift = allShifts.length > 0 ? allShifts[allShifts.length - 1] : null;
        const latestHint = latestShift
            ? `\n• **Most Recent Recorded Shift:** **${latestShift.date}** — **${latestShift.cases.toLocaleString()} cases** (**${latestShift.tons.toFixed(2)} tons**)`
            : "";

        if (matchedMonths && matchedMonths.length === 1) {
            const monthShifts = allShifts.filter(s => s.month === matchedMonths[0] && (!targetYear || s.year === targetYear));
            if (monthShifts.length > 0) {
                const availableDates = [...new Set(monthShifts.map(s => s.date))].join(", ");
                return `⚠️ **No Shift Recorded on ${filterLabel}**${latestHint}\n\n📅 **Available Dates in ${MONTH_NAMES[matchedMonths[0]]}:**\n• ${availableDates}`;
            }
        }
        return `⚠️ **No production shift records were found for ${filterLabel}.**${latestHint}`;
    }

    const asksDaily = /\b(daily|date wise|day by day|each day|shift by shift)\b/i.test(lowerMsg);
    const asksSeparateOrCompare = /\b(separately|sepratly|separate|each|vs|versus|compare|comparison|both)\b/i.test(lowerMsg);
    const asksChangeovers = /\b(changeover|changeovers|change over|change overs|mechanical|size change|color change|colour change)\b/i.test(lowerMsg);
    const asksBestOrWorst = /\b(best|highest|most|top|worst|lowest|least|record|peak)\b/i.test(lowerMsg);
    const asksBrandSplit = /\b(lux|lifebuoy|brand)\b/i.test(lowerMsg);
    const asksDowntime = /(breakdown|downtime|stoppage|stopped|fault|break\b)/i.test(lowerMsg);
    const asksTonsOnly = /(ton|tonnage|weight)/i.test(lowerMsg) && !/(case|variant|sku|what we produced|breakdown|lux|lifebuoy)/i.test(lowerMsg);
    const asksCasesOnly = /\b(case|cases|boxes)\b/i.test(lowerMsg) && !/(ton|variant|sku|what we produced|breakdown|lux|lifebuoy)/i.test(lowerMsg);
    const asksOeeOnly = /\b(oee|efficiency|target)\b/i.test(lowerMsg);

    const unreportedNote = stats.unreported_count > 0
        ? `\n• *⚠️ Note: ${stats.unreported_count} automated shift (${stats.unreported_cases.toLocaleString()} cases) is awaiting a generated OEE/tonnage report.*`
        : "";

    const legacyNote = stats.legacy_count > 0
        ? `\n\n*ℹ️ **Monitoring Note:** Automatic IoT shift monitoring started on **${firstAutoDateStr}** (${stats.automated_count} automated shift${stats.automated_count === 1 ? "" : "s"} in this period). The **${stats.legacy_count} earlier manual shift${stats.legacy_count === 1 ? "" : "s"}** do not contain automated changeover, breakdown, or hourly sensor logs.*`
        : "";

    // 0A. Multi-Month "Separately" / "VS" Requests
    if (Object.keys(stats.matched_month_breakdown || {}).length > 1 && (asksSeparateOrCompare || asksTonsOnly || asksCasesOnly)) {
        const monthBullets = Object.entries(stats.matched_month_breakdown).map(([mName, mData]) => {
            return `• **${mName}:** **${mData.tons.toFixed(2)} tons** (${mData.cases.toLocaleString()} cases across ${mData.shifts} shifts)`;
        }).join("\n");

        return `📊 **Monthly Breakdown — ${filterLabel}**\n${monthBullets}\n\n• **Combined Total:** **${stats.total_tons.toFixed(2)} tons** (${stats.total_cases.toLocaleString()} cases across ${stats.shift_count} shifts)${legacyNote}`;
    }

    // 0B. "Date Wise" / "Daily" Requests
    if (asksDaily) {
        const slice = stats.shifts_list.slice(-35);
        const dailyList = slice.map(s => `• **${s.date}:** ${s.cases.toLocaleString()} cases (${s.tons.toFixed(2)} t)`).join("\n");
        const capNote = stats.shifts_list.length > 35 ? `\n\n*(Showing the latest 35 of ${stats.shifts_list.length} shifts)*` : "";
        return `📅 **${filterLabel} — Daily Breakdown**\n${dailyList}${capNote}`;
    }

    // 1. Changeover Report
    if (asksChangeovers) {
        const co = stats.changeovers;
        if (co.total_count === 0) {
            return `🔄 **${filterLabel} — Changeover Summary (${stats.shift_count} Shifts)**\n• **Total Changeovers:** **0 tagged changeovers**${legacyNote}`;
        }
        const recentList = co.events.slice(-10).map(e =>
            `• **${e.date} (${e.time}):** ${e.from} → **${e.to}** *[${e.type_label}, ${e.duration_str}]*`
        ).join("\n");

        return `🔄 **${filterLabel} — Changeover Report (${stats.shift_count} Shifts)**\n` +
            `• **Total Changeovers:** **${co.total_count} changeover${co.total_count > 1 ? "s" : ""}** *(${co.total_time_str} total)*\n` +
            `• **Color Changeovers (Variant Only):** **${co.color_count}** *(${co.color_time_str})*\n` +
            `• **Mechanical Changeovers (Size Only):** **${co.mechanical_count}** *(${co.mechanical_time_str})*\n` +
            `• **Both (Color + Size Changeover):** **${co.both_count}** *(${co.both_time_str})*` +
            (recentList ? `\n\n📋 **Tagged Changeover Log:**\n${recentList}` : "") +
            legacyNote;
    }

    // 2. Shift Records & True Single-Hour Peak
    if (asksBestOrWorst && stats.records.best_cases) {
        const r = stats.records;
        return `🏆 **Shift Records — ${filterLabel} (${stats.shift_count} Shifts)**\n` +
            `• **Highest Production Shift:** **${r.best_cases.date}** — **${r.best_cases.cases.toLocaleString()} cases** (${r.best_cases.tons.toFixed(2)} tons)\n` +
            `• **Lowest Production Shift:** **${r.lowest_cases.date}** — **${r.lowest_cases.cases.toLocaleString()} cases** (${r.lowest_cases.tons.toFixed(2)} tons)\n` +
            (r.best_oee ? `• **Best OEE:** **${r.best_oee.date}** — **${r.best_oee.oee.toFixed(2)}%**\n` : "") +
            (r.worst_downtime && r.worst_downtime.downtime_mins > 0 ? `• **Highest Downtime:** **${r.worst_downtime.date}** — **${r.worst_downtime.downtime_str}** (${r.worst_downtime.breakdown_count} stops)\n` : "") +
            (stats.peak_hour ? `• **Peak Single-Hour Output:** **${stats.peak_hour.cases.toLocaleString()} cases** *(on ${stats.peak_hour.date}, ${stats.peak_hour.hour})*` : "") +
            legacyNote;
    }

    // 3. Brand Split
    if (asksBrandSplit && Object.keys(stats.brands).length > 0) {
        const brandBullets = Object.entries(stats.brands).sort((a, b) => b[1].cases - a[1].cases).map(([bName, d]) => `• **${bName}:** **${d.cases.toLocaleString()} cases** (**${d.tons.toFixed(2)} tons** — ${d.share_pct}%)`).join("\n");
        return `📊 **Brand Split — ${filterLabel} (${stats.shift_count} Shifts)**\n${brandBullets}\n• **Combined Total:** ${stats.total_cases.toLocaleString()} cases (${stats.total_tons.toFixed(2)} tons)${unreportedNote}`;
    }

    // 4. Downtime Report
    if (asksDowntime) {
        if (stats.legacy_count === stats.shift_count) {
            return `⏱️ **${filterLabel} — Downtime Report**\n• **Recorded Breakdown Time:** 0 minutes\n• **Note:** All **${stats.shift_count} shifts** in this period were manually entered before automatic IoT monitoring began on **${firstAutoDateStr}**, so automated breakdown logs are not available.`;
        }
        return `⏱️ **${filterLabel} — Stoppage & Downtime Summary**\n` +
            `• **True Breakdown Time:** **${stats.total_downtime_str}** *(across ${stats.total_breakdowns} stops)*\n` +
            `• **Tagged Changeovers:** **${stats.changeovers.total_count} changeovers** *(${stats.changeovers.total_time_str})*\n` +
            `• **Break Time:** **${stats.total_break_str}**${legacyNote}`;
    }

    if (asksTonsOnly) return `⚖️ **${filterLabel} — Total Tonnage**\n• **Total Weight:** **${stats.total_tons.toFixed(2)} tons**\n• **Total Cases:** ${stats.total_cases.toLocaleString()} cases *(across ${stats.shift_count} shifts)*${unreportedNote}`;
    if (asksCasesOnly) return `📦 **${filterLabel} — Total Cases**\n• **Total Output:** **${stats.total_cases.toLocaleString()} cases**\n• **Total Weight:** ${stats.total_tons.toFixed(2)} tons *(across ${stats.shift_count} shifts)*${unreportedNote}`;
    if (asksOeeOnly) return stats.avg_oee !== null ? `📈 **${filterLabel} — Efficiency (OEE)**\n• **Average OEE:** **${stats.avg_oee}%**\n• **Output:** ${stats.total_cases.toLocaleString()} cases (${stats.total_tons.toFixed(2)} tons across ${stats.shift_count} shifts)` : `ℹ️ No OEE percentage was calculated for **${filterLabel}**.`;

    // 5. Generic Shift / Period Summary
    const variantBullets = Object.entries(stats.variants).sort((a, b) => b[1].cases - a[1].cases).map(([v, d]) => `• **${v}:** ${d.cases.toLocaleString()} cases *(${d.tons.toFixed(2)} t)*`).join("\n");

    return `📊 **${filterLabel} — Production Summary**\n` +
        `• **Total Output:** **${stats.total_cases.toLocaleString()} cases** (**${stats.total_tons.toFixed(2)} tons**)\n` +
        `• **Shifts Logged:** ${stats.shift_count} shift${stats.shift_count > 1 ? "s" : ""}${stats.avg_oee ? ` | **Avg OEE:** **${stats.avg_oee}%**` : ""}\n` +
        `• **True Downtime:** ${stats.total_downtime_str} | **Changeovers:** ${stats.changeovers.total_count} (${stats.changeovers.total_time_str})` +
        `${unreportedNote}${variantBullets ? `\n\n📦 **Breakdown by Variant:**\n${variantBullets}` : ""}${legacyNote}`;
}

exports.handler = async function(event, context) {
    context.callbackWaitsForEmptyEventLoop = false;

    try {
        const body = event.body ? JSON.parse(event.body) : {};
        const message = (body.message || "").trim();
        const chatHistory = Array.isArray(body.history) ? body.history.slice(-6) : [];

        if (!message) return { statusCode: 200, body: JSON.stringify({ reply: "Please enter a question about your factory data." }) };
        const lowerMsg = message.toLowerCase().trim();

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

        let adjTotal = typeof adjData === "number" ? adjData : (adjData && typeof adjData === "object" ? Number(adjData.total) || 0 : 0);
        const liveCasesNow = Math.max(0, Number((liveData && liveData.total_cases) || 0) + adjTotal);
        const liveStatusStr = liveData && liveData.line_status ? liveData.line_status : "Shift Inactive";
        const liveBreakdownStr = formatDuration(Math.round(Number((liveData && liveData.breakdown_seconds) || 0) / 60));

        if (/^(hi|hello|hey|salam|good morning|good evening|help)[\s!?.]*$/i.test(lowerMsg)) {
            return {
                statusCode: 200,
                body: JSON.stringify({ reply: `👋 **Hello! I'm your Factory AI Analyst.**\n\n🟢 **Live Line Status:** **${liveStatusStr}** (${liveCasesNow.toLocaleString()} cases)\n\n💡 **Try asking me:**\n• *"What did we produce yesterday?"*\n• *"September and October tons separately"*\n• *"How many changeovers we did this year?"*\n• *"Tell me production split in LUX and Lifebuoy"*` })
            };
        }

        const rawEntries = rawHistory ? Object.values(rawHistory) : [];
        const sortedRaw = rawEntries.filter(Boolean).sort((a, b) => (a.shift_start || a.saved_at || 0) - (b.shift_start || b.saved_at || 0));

        let lastGlobalVariant = null;
        let lastGlobalTransitionKey = null;

        const allShifts = sortedRaw.map(s => {
            const d = resolveShiftDate(s);
            const r = s.report || null;
            const cases = Number(s.total_cases || s.cases || s.cases_produced || 0);
            const tons = Number((r && r.total_tons) || s.tonnage || s.tons || 0);
            const rawDowntimeSec = Number(s.total_downtime_seconds || 0);
            const trueDowntimeSec = Number((r && r.true_downtime_seconds) ?? rawDowntimeSec);
            const breakSec = Number((r && r.break_time_seconds) || 0);
            const oee = (r && typeof r.oee_percent === "number") ? Number(r.oee_percent) : null;
            const variantTotals = (r && r.variant_totals) ? r.variant_totals : {};
            const variantTons = (r && r.variant_tons) ? r.variant_tons : {};
            const rawChangeovers = (r && Array.isArray(r.changeovers)) ? [...r.changeovers].sort((a, b) => (a.start || 0) - (b.start || 0)) : [];
            const breakdowns = Array.isArray(s.breakdowns) ? s.breakdowns : [];
            const hourly = (s.hourly_production && typeof s.hourly_production === "object") ? s.hourly_production : {};
            const formattedDate = s.date || s.shift_date || (d ? `${String(d.day).padStart(2, "0")}-${String(d.month + 1).padStart(2, "0")}-${d.year}` : "Unknown");

            let cursorVariant = (r && r.starting_variant) ? String(r.starting_variant).trim() : lastGlobalVariant;
            const dedupedChangeovers = [];

            rawChangeovers.forEach(c => {
                const toVar = String(c.to || "").trim();
                if (!toVar) return;
                let fromVar = cursorVariant;
                if (fromVar && fromVar.toLowerCase() === toVar.toLowerCase() && lastGlobalVariant && lastGlobalVariant.toLowerCase() !== toVar.toLowerCase()) fromVar = lastGlobalVariant;
                
                const transitionKey = `${(fromVar || "unknown").toLowerCase()}->${toVar.toLowerCase()}`;
                const durMins = Math.round(Number(c.duration || 0) / 60);
                const prevInShift = dedupedChangeovers[dedupedChangeovers.length - 1];

                // Deduplicate identical consecutive changeovers in same shift
                if (prevInShift && (prevInShift.transitionKey === transitionKey || prevInShift.to.toLowerCase() === toVar.toLowerCase())) {
                    if (prevInShift.rawStart !== c.start || prevInShift.mins !== durMins) {
                        prevInShift.mins += durMins;
                        prevInShift.duration_str = formatDuration(prevInShift.mins);
                    }
                    cursorVariant = toVar;
                    return;
                }
                // Deduplicate boundary changeover already tagged at end of previous shift
                if (dedupedChangeovers.length === 0 && lastGlobalTransitionKey === transitionKey) {
                    cursorVariant = toVar;
                    return;
                }

                const coType = classifyChangeoverType(fromVar, toVar);
                dedupedChangeovers.push({
                    date: formattedDate,
                    rawStart: c.start,
                    time: formatQatarTime(c.start),
                    from: fromVar || "Previous Variant",
                    to: toVar,
                    type: coType,
                    type_label: coType === "both" ? "Color + Size" : (coType === "mechanical" ? "Mechanical (Size)" : "Color (Variant)"),
                    mins: durMins,
                    duration_str: formatDuration(durMins),
                    transitionKey
                });
                cursorVariant = toVar;
                lastGlobalTransitionKey = transitionKey;
            });

            if (cursorVariant) lastGlobalVariant = cursorVariant;
            else if (Object.keys(variantTotals).length > 0) lastGlobalVariant = Object.keys(variantTotals)[0];
            if (dedupedChangeovers.length === 0) lastGlobalTransitionKey = null;

            const dedupedChangeoverMins = dedupedChangeovers.reduce((sum, item) => sum + item.mins, 0);
            const dtMins = Math.round(trueDowntimeSec / 60);
            const coMins = dedupedChangeovers.length > 0 ? dedupedChangeoverMins : Math.round(Number((r && r.changeover_time_seconds) || 0) / 60);
            const brkMins = Math.round(breakSec / 60);

            return {
                date: formattedDate, day: d ? d.day : null, month: d ? d.month : null, year: d ? d.year : null, dayValue: d ? d.dayValue : 0,
                shift_start_str: formatQatarTime(s.shift_start), shift_end_str: formatQatarTime(s.shift_end),
                cases, tons, oee, has_report: !!r, source: s.source === "legacy_manual" ? "legacy_manual" : "automated",
                downtime_mins: dtMins, downtime_str: formatDuration(dtMins),
                changeover_mins: coMins, changeover_str: formatDuration(coMins),
                break_mins: brkMins, break_str: formatDuration(brkMins),
                breakdown_count: Number((r && r.true_breakdown_count) ?? s.breakdown_count ?? 0),
                variant_totals: variantTotals, variant_tons: variantTons, hourly_production: hourly,
                changeovers_detail: dedupedChangeovers,
                breakdowns_detail: breakdowns.map(b => {
                    const bMins = Math.round((b.duration || 0) / 60);
                    return { time: formatQatarTime(b.start), mins: bMins, duration_str: formatDuration(bMins) };
                })
            };
        });

        // Dynamically detect when automated IoT shift tracking started
        const firstAutoShift = allShifts.find(s => s.source === "automated");
        const firstAutoDateStr = firstAutoShift ? firstAutoShift.date : "12-09-2026";

        // Current Qatar Date & Time Anchor (GMT+3)
        const nowQatar = new Date(Date.now() + (3 * 3600 * 1000));
        const currentQatarDateStr = `${DAY_NAMES[nowQatar.getUTCDay()]}, ${nowQatar.getUTCDate()} ${MONTH_NAMES[nowQatar.getUTCMonth()]} ${nowQatar.getUTCFullYear()}`;

        let activeFilter = extractTimeFilter(lowerMsg, allShifts, nowQatar);

        // Inherit previous date filter on conversational follow-ups
        if (activeFilter.type === "none" && chatHistory.length > 0) {
            for (let i = chatHistory.length - 1; i >= 0; i--) {
                if (chatHistory[i].role === "user") {
                    const prevFilter = extractTimeFilter(chatHistory[i].content, allShifts, nowQatar);
                    if (prevFilter.type !== "none") {
                        activeFilter = prevFilter;
                        break;
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
            if (targetYear) { filteredShifts = filteredShifts.filter(s => s.year === targetYear); filterLabel = `Year ${targetYear}`; }
            if (matchedMonths.length > 0) {
                if (!targetYear) {
                    const availableYears = filteredShifts.filter(s => matchedMonths.includes(s.month) && s.year).map(s => s.year);
                    if (availableYears.length > 0) targetYear = Math.max(...availableYears);
                }
                filteredShifts = filteredShifts.filter(s => matchedMonths.includes(s.month) && (!targetYear || s.year === targetYear));
                if (activeFilter.requestedDay !== null) {
                    filteredShifts = filteredShifts.filter(s => s.day === activeFilter.requestedDay);
                    filterLabel = activeFilter.customLabel || `${activeFilter.requestedDay} ${MONTH_NAMES[matchedMonths[0]]}${targetYear ? " " + targetYear : ""}`;
                } else {
                    filterLabel = `${matchedMonths.map(m => MONTH_NAMES[m]).join(", ")}${targetYear ? " " + targetYear : ""}`;
                }
            }
        } else if (activeFilter.type === "slice") {
            filteredShifts = allShifts.slice(-activeFilter.count);
            if (activeFilter.count === 1 && filteredShifts.length === 1) {
                filterLabel = `Latest Shift (${filteredShifts[0].date})`;
            } else {
                filterLabel = activeFilter.label;
            }
        }

        function aggregateShifts(shiftsArray) {
            let totalCases = 0, totalTons = 0, totalDowntimeMins = 0, totalBreakMins = 0, totalBreakdowns = 0;
            let oeeSum = 0, oeeCount = 0, legacyCount = 0, unreportedCount = 0, unreportedCases = 0;
            const byVariant = {}, byBrand = {}, byMonth = {}, hourlySum = {}, hourlyCounts = {};
            const changeoverStats = { total_count: 0, total_mins: 0, color_count: 0, color_mins: 0, mechanical_count: 0, mechanical_mins: 0, both_count: 0, both_mins: 0, events: [] };
            let bestCasesShift = null, lowestCasesShift = null, bestOeeShift = null, worstOeeShift = null, worstDowntimeShift = null;
            let peakSingleHour = null;

            shiftsArray.forEach(s => {
                totalCases += s.cases; totalTons += s.tons; totalDowntimeMins += s.downtime_mins; totalBreakMins += s.break_mins; totalBreakdowns += s.breakdown_count;
                if (s.source === "legacy_manual") legacyCount++;
                if (!s.has_report && s.source !== "legacy_manual") { unreportedCount++; unreportedCases += s.cases; }

                (s.changeovers_detail || []).forEach(co => {
                    changeoverStats.total_count += 1; changeoverStats.total_mins += co.mins;
                    if (co.type === "color") { changeoverStats.color_count += 1; changeoverStats.color_mins += co.mins; }
                    else if (co.type === "mechanical") { changeoverStats.mechanical_count += 1; changeoverStats.mechanical_mins += co.mins; }
                    else if (co.type === "both") { changeoverStats.both_count += 1; changeoverStats.both_mins += co.mins; }
                    changeoverStats.events.push(co);
                });

                if (s.oee !== null && s.oee > 0) {
                    oeeSum += s.oee; oeeCount++;
                    if (!bestOeeShift || s.oee > bestOeeShift.oee) bestOeeShift = { date: s.date, oee: Number(s.oee.toFixed(2)), cases: s.cases, tons: Number(s.tons.toFixed(2)) };
                    if (!worstOeeShift || s.oee < worstOeeShift.oee) worstOeeShift = { date: s.date, oee: Number(s.oee.toFixed(2)), cases: s.cases, tons: Number(s.tons.toFixed(2)) };
                }

                if (!bestCasesShift || s.cases > bestCasesShift.cases) bestCasesShift = { date: s.date, cases: s.cases, tons: Number(s.tons.toFixed(2)), oee: s.oee };
                if (s.cases > 0 && (!lowestCasesShift || s.cases < lowestCasesShift.cases)) lowestCasesShift = { date: s.date, cases: s.cases, tons: Number(s.tons.toFixed(2)), oee: s.oee };
                if (!worstDowntimeShift || s.downtime_mins > worstDowntimeShift.downtime_mins) {
                    worstDowntimeShift = { date: s.date, downtime_mins: s.downtime_mins, downtime_str: s.downtime_str, breakdown_count: s.breakdown_count, cases: s.cases };
                }

                // Track true single-shift peak hour instead of summing across multiple days
                Object.entries(s.hourly_production || {}).forEach(([hLabel, hCases]) => {
                    const c = Number(hCases || 0);
                    if (c > 0) {
                        hourlySum[hLabel] = (hourlySum[hLabel] || 0) + c;
                        hourlyCounts[hLabel] = (hourlyCounts[hLabel] || 0) + 1;
                        if (!peakSingleHour || c > peakSingleHour.cases) {
                            peakSingleHour = { hour: hLabel, cases: c, date: s.date };
                        }
                    }
                });

                const mKey = (s.year && s.month !== null) ? `${MONTH_NAMES[s.month]} ${s.year}` : "Unknown";
                if (!byMonth[mKey]) {
                    byMonth[mKey] = { shifts: 0, automated_shifts: 0, legacy_shifts: 0, cases: 0, tons: 0, lux_cases: 0, lux_tons: 0, lifebuoy_cases: 0, lifebuoy_tons: 0 };
                }
                byMonth[mKey].shifts += 1; byMonth[mKey].cases += s.cases; byMonth[mKey].tons = Number((byMonth[mKey].tons + s.tons).toFixed(2));
                if (s.source === "legacy_manual") byMonth[mKey].legacy_shifts += 1;
                else byMonth[mKey].automated_shifts += 1;

                Object.entries(s.variant_totals || {}).forEach(([vName, vCases]) => {
                    const c = Number(vCases || 0), t = Number((s.variant_tons && s.variant_tons[vName]) || 0);
                    if (!byVariant[vName]) byVariant[vName] = { cases: 0, tons: 0 };
                    byVariant[vName].cases += c; byVariant[vName].tons = Number((byVariant[vName].tons + t).toFixed(2));
                    const upperV = vName.toUpperCase();
                    const brandName = upperV.includes("LUX") ? "LUX" : (upperV.includes("LIFEBUOY") ? "Lifebuoy" : "Other");
                    if (!byBrand[brandName]) byBrand[brandName] = { cases: 0, tons: 0, share_pct: 0 };
                    byBrand[brandName].cases += c; byBrand[brandName].tons = Number((byBrand[brandName].tons + t).toFixed(2));
                    if (brandName === "LUX") { byMonth[mKey].lux_cases += c; byMonth[mKey].lux_tons = Number((byMonth[mKey].lux_tons + t).toFixed(2)); }
                    else if (brandName === "Lifebuoy") { byMonth[mKey].lifebuoy_cases += c; byMonth[mKey].lifebuoy_tons = Number((byMonth[mKey].lifebuoy_tons + t).toFixed(2)); }
                });
            });

            Object.keys(byBrand).forEach(b => { byBrand[b].share_pct = totalCases > 0 ? Number(((byBrand[b].cases / totalCases) * 100).toFixed(1)) : 0; });

            const hourlyAverages = {};
            Object.keys(hourlySum).forEach(hLabel => {
                hourlyAverages[hLabel] = shiftsArray.length === 1
                    ? hourlySum[hLabel]
                    : Math.round(hourlySum[hLabel] / (hourlyCounts[hLabel] || 1));
            });

            changeoverStats.total_time_str = formatDuration(changeoverStats.total_mins);
            changeoverStats.color_time_str = formatDuration(changeoverStats.color_mins);
            changeoverStats.mechanical_time_str = formatDuration(changeoverStats.mechanical_mins);
            changeoverStats.both_time_str = formatDuration(changeoverStats.both_mins);

            const matchedMonthBreakdown = {};
            if (matchedMonths && matchedMonths.length > 0) {
                matchedMonths.forEach(mIdx => {
                    const mName = MONTH_NAMES[mIdx];
                    Object.keys(byMonth).forEach(k => {
                        if (k.startsWith(mName)) matchedMonthBreakdown[k] = byMonth[k];
                    });
                });
            }

            return { 
                shift_count: shiftsArray.length, 
                shifts_list: shiftsArray, 
                legacy_count: legacyCount, 
                automated_count: shiftsArray.length - legacyCount, 
                unreported_count: unreportedCount, 
                unreported_cases: unreportedCases, 
                total_cases: totalCases, 
                total_tons: Number(totalTons.toFixed(2)), 
                avg_oee: oeeCount > 0 ? Number((oeeSum / oeeCount).toFixed(2)) : null, 
                total_downtime_mins: totalDowntimeMins,
                total_downtime_str: formatDuration(totalDowntimeMins),
                total_break_mins: totalBreakMins,
                total_break_str: formatDuration(totalBreakMins),
                total_breakdowns: totalBreakdowns, 
                changeovers: changeoverStats, 
                brands: byBrand, 
                variants: byVariant, 
                hourly_averages: hourlyAverages, 
                peak_hour: peakSingleHour, 
                matched_month_breakdown: matchedMonthBreakdown,
                records: { best_cases: bestCasesShift, lowest_cases: lowestCasesShift, best_oee: bestOeeShift, worst_oee: worstOeeShift, worst_downtime: worstDowntimeShift }, 
                monthly_rollup: byMonth 
            };
        }

        const stats = aggregateShifts(filteredShifts);
        const globalMonthly = aggregateShifts(allShifts).monthly_rollup;

        const wantsDaily = /\b(daily|date wise|day by day|each day|every day|shift by shift)\b/i.test(lowerMsg);
        const asksSeparate = /\b(separately|sepratly|separate|each|vs|versus|compare|both)\b/i.test(lowerMsg);
        const isMultiMonth = Object.keys(stats.matched_month_breakdown || {}).length > 1;

        if (stats.shift_count === 0 || wantsDaily || (isMultiMonth && asksSeparate)) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reply: buildFocusedJSReply(lowerMsg, filterLabel, stats, allShifts, matchedMonths, targetYear, firstAutoDateStr) })
            };
        }

        const wantsChart = /\b(graph|chart|plot|visual|bar|pie|doughnut|line)\b/i.test(lowerMsg);
        if (wantsChart) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reply: buildNativeChartReply(lowerMsg, filterLabel, stats, filteredShifts, globalMonthly) })
            };
        }

        // Clean shift timeline context so the AI can see dates and runs without guessing math
        const isSmallSlice = filteredShifts.length <= 5;
        const compactRows = filteredShifts.slice(-20).map(s => {
            const row = {
                date: s.date,
                cases: s.cases,
                tons: Number(s.tons.toFixed(2)),
                oee: s.oee !== null ? Number(s.oee.toFixed(1)) : null,
                downtime: s.downtime_str,
                changeovers: s.changeovers_detail.length,
                changeover_time: s.changeover_str,
                source: s.source,
                variants: s.variant_totals
            };
            if (isSmallSlice) {
                row.hourly_production = s.hourly_production;
                row.changeovers_log = s.changeovers_detail;
                row.breakdowns_log = s.breakdowns_detail;
            }
            return row;
        });

        const userAsksBrand = /\b(lux|lifebuoy|brand)\b/i.test(lowerMsg);
        const brandSectionForPrompt = userAsksBrand ? `- PRE-CALCULATED BRAND SPLIT (LUX vs Lifebuoy): ${JSON.stringify(stats.brands)}\n` : "";
        const multiMonthSectionForPrompt = isMultiMonth ? `- PRE-CALCULATED MONTH-BY-MONTH BREAKDOWN: ${JSON.stringify(stats.matched_month_breakdown)}\n` : "";
        const legacyPromptContext = stats.legacy_count > 0
            ? `- HISTORICAL DATA LIMITATION NOTE: Automatic IoT shift monitoring on this line began on ${firstAutoDateStr} (${stats.automated_count} automated shifts in this period). The ${stats.legacy_count} earlier shifts in this period are "legacy_manual" entries, which only recorded total cases, tonnage, and variants—they DO NOT contain automated changeover logs, breakdown timestamps, OEE, or hourly sensor buckets.`
            : `- DATA COVERAGE: All ${stats.shift_count} shifts in this period are fully automated IoT records.`;

        const systemPrompt = `You are the Factory AI Analyst for a Unilever production line.

CURRENT QATAR DATE (GMT+3): ${currentQatarDateStr}
LIVE ACTIVE SHIFT RIGHT NOW: Status: ${liveStatusStr}, Live Cases: ${liveCasesNow.toLocaleString()}, Active Breakdown: ${liveBreakdownStr}.

VERIFIED JS-CALCULATED TOTALS FOR "${filterLabel}" (${stats.shift_count} Shifts):
- Matched Shifts: ${stats.shift_count} (${stats.automated_count} automated IoT shifts, ${stats.legacy_count} legacy manual shifts)
${legacyPromptContext}
- Total Cases Produced: ${stats.total_cases.toLocaleString()} cases
- Total Tonnage: ${stats.total_tons.toFixed(2)} tons
- Average OEE: ${stats.avg_oee !== null ? stats.avg_oee + "%" : "N/A"}
- Total True Downtime: ${stats.total_downtime_str} (across ${stats.total_breakdowns} breakdowns)
- Total Break Time: ${stats.total_break_str}
${multiMonthSectionForPrompt}- VERIFIED DEDUPLICATED CHANGEOVERS FOR "${filterLabel}":
  * Total Changeovers Count: ${stats.changeovers.total_count} changeovers (Total time: ${stats.changeovers.total_time_str})
  * Color Changeovers (Variant changed, size same): ${stats.changeovers.color_count} (${stats.changeovers.color_time_str})
  * Mechanical Changeovers (Size/GM changed, variant same): ${stats.changeovers.mechanical_count} (${stats.changeovers.mechanical_time_str})
  * Both (Color + Size changed together): ${stats.changeovers.both_count} (${stats.changeovers.both_time_str})
  * Tagged Changeover Events List (Oldest to Newest): ${JSON.stringify(stats.changeovers.events.slice(-25))}
- Peak Single-Hour Production Record in Period: ${stats.peak_hour ? `${stats.peak_hour.cases.toLocaleString()} cases (on ${stats.peak_hour.date} during hour${stats.peak_hour.hour})` : "N/A"}
- ALL-SHIFT RECORDS (BEST / WORST IN PERIOD): ${JSON.stringify(stats.records)}
${brandSectionForPrompt}- Production by Individual Variant: ${JSON.stringify(stats.variants)}

ALL-TIME MONTHLY ROLLUP:
${JSON.stringify(globalMonthly)}

RECENT SHIFT LOGS IN "${filterLabel}":
${JSON.stringify(compactRows)}

RESPONSE GUIDELINES:
1. USE VERIFIED TOTALS: Always use the pre-calculated totals above for overall figures. Never manually sum rows yourself.
2. TIME FORMATTING RULE: Whenever mentioning any duration (downtime, changeovers, breaks) of 60 minutes or more, ALWAYS format it in hours and minutes (e.g., "1 hour 20 minutes" instead of "80 minutes"), matching the pre-formatted strings above.
3. LEGACY vs AUTOMATED DISCLOSURE: Whenever the user asks about changeovers, breakdowns/downtime, OEE, or hourly peaks for a period where legacy_manual shifts > 0 (such as the whole year or all-time), clearly mention that automatic shift monitoring started on ${firstAutoDateStr} and that the ${stats.legacy_count} earlier manual shifts do not contain changeover or stoppage records.
4. PEAK HOUR RULE: Peak production hour is a single-hour record from a single shift (${stats.peak_hour ? `${stats.peak_hour.cases} cases on ${stats.peak_hour.date} at${stats.peak_hour.hour}` : "N/A"}), never a sum across multiple days.
5. BRAND SPLIT RULE: Only show the LUX vs. Lifebuoy brand split if the user explicitly asks about "brand", "LUX", or "Lifebuoy".
6. FORMATTING: Present answers as a clean executive card using "• " bullet points and bold labels. Do not use Markdown |---| tables or ### headers.`;

        let replyText = "";
        const groqKey = (process.env.GROQ_API_KEY || "").trim();
        if (groqKey) {
            const groqModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
            const messagesPayload = [
                { role: "system", content: systemPrompt },
                ...chatHistory.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 600) })),
                { role: "user", content: message }
            ];

            for (const gModel of groqModels) {
                if (replyText) break;
                try {
                    const reqBody = { model: gModel, messages: messagesPayload, temperature: 0.1, max_completion_tokens: 2048 };
                    if (gModel.startsWith("openai/gpt-oss")) reqBody.reasoning_effort = "low";
                    const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" }, body: JSON.stringify(reqBody) }, 4500);
                    if (groqRes.ok) {
                        const groqData = await groqRes.json();
                        replyText = formatForChatUI(groqData.choices?.[0]?.message?.content);
                    }
                } catch (err) { console.warn("Groq failover:", err.message); }
            }
        }

        if (!replyText) replyText = buildFocusedJSReply(lowerMsg, filterLabel, stats, allShifts, matchedMonths, targetYear, firstAutoDateStr);

        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: replyText }) };
    } catch (error) {
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: `⚠️ Unable to process that request right now (${error.message}). Please try again.` }) };
    }
};
