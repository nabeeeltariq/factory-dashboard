const { GoogleGenerativeAI } = require("@google/generative-ai");

const sleep = (ms) => new Promise((resolve) => {
    const jitter = Math.floor(Math.random() * 300); 
    setTimeout(resolve, ms + jitter);
});

exports.handler = async function(event, context) {
    // Tell Netlify not to wait for background tasks to finish
    context.callbackWaitsForEmptyEventLoop = false; 
    
    // Start our stopwatch
    const startTime = Date.now();
    const MAX_TIME_MS = 25000; // 25 seconds (leaves 5s safety buffer before Netlify kills it)

    try {
        const { message } = JSON.parse(event.body);

        // 1. Fetch recent shift data from Firebase
        const firebaseURL = "https://automation-60207-default-rtdb.firebaseio.com/shift_history.json";
        const fbRes = await fetch(firebaseURL);
        let historyData = await fbRes.json();

        // --- NEW OPTIMIZATION: SMART PAYLOAD FILTER ---
        if (historyData) {
            let dataArray = Array.isArray(historyData) ? historyData : Object.values(historyData);
            const lowerMessage = message.toLowerCase();
            
            // Check if the user asks for historical months, "year", or "all"
            const askingForHistory = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "year", "all"]
                .some(keyword => lowerMessage.includes(keyword));

            if (!askingForHistory) {
                // Keep only the latest 40 shifts for standard queries
                dataArray = dataArray.slice(-40); 
            }
            
            historyData = dataArray;
        }
        // --- END OF OPTIMIZATION ---

        // 2. Pre-calculate exact mathematical totals in JS
        const minifiedData = historyData.map(s => {
            const caseCount = Number(s.total_cases || s.cases || s.cases_produced || 0);
            const tonCount = Number(s.tonnage || s.tons || (s.report && s.report.total_tons) || 0);

            return {
                date: s.date || s.shift_date,
                cases: caseCount,
                tons: tonCount,
                source: s.source || "automated",
                downtime: s.total_downtime_seconds || 0
            };
        });

        const totals = minifiedData.reduce((acc, shift) => {
            acc.cases += shift.cases;
            acc.tons += shift.tons;
            return acc;
        }, { cases: 0, tons: 0 });

        // 3. Initialize Gemini securely
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        // 4. The Strict Factory System Prompt (Merged with verified totals)
        const systemPrompt = `You are a data analyst for a Unilever factory floor.

VERIFIED CALCULATED TOTALS FOR THIS REQUESTED PERIOD:
- Total Cases: ${totals.cases.toLocaleString()} cases
- Total Tonnage: ${totals.tons.toFixed(2)} tons

Shift Data Details: ${JSON.stringify(minifiedData)}

Rules:
- ALWAYS use the VERIFIED CALCULATED TOTALS provided above for any sum or summary questions.
- Never attempt to manually calculate or add up the individual shift numbers yourself.
- ALWAYS be extremely concise and answer straight to the point.
- If the user asks a general question (e.g., "tell me August production"), provide ONLY the final total numbers (total cases, total tons) in 1 or 2 short sentences. Do NOT list daily or shift-by-shift details unless explicitly requested.
- If a shift record contains the flag "source": "legacy_manual", explicitly mention that this record is from historical manual entries, so no breakdown or exact shift-timing metrics are available. Provide only the date, variant, cases, and tonnage.
- If the user asks for a graph or chart, you MUST output a raw JSON block wrapped in \`\`\`json and \`\`\` markers containing a Chart.js configuration object.`;

        // 5. Robust Retry with Timeout Protection
        const modelsToTry = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-pro"];
        let responseText = null;
        let lastError = null;

        for (const modelName of modelsToTry) {
            if (responseText) break;

            const model = genAI.getGenerativeModel({ model: modelName });
            let retries = 2; // Reduced retries to save time
            let backoffMs = 1000;

            while (retries > 0) {
                // WATCHDOG CHECK: Are we about to hit Netlify's 30s limit?
                if (Date.now() - startTime > MAX_TIME_MS) {
                    return {
                        statusCode: 200,
                        body: JSON.stringify({ reply: "My connection timed out due to heavy server traffic. Please try again." })
                    };
                }

                try {
                    const result = await model.generateContent([systemPrompt, message]);
                    responseText = result.response.text();
                    break; 
                } catch (error) {
                    lastError = error;
                    const status = error.status || (error.response && error.response.status);

                    if (status === 503 || status === 429) {
                        retries--;
                        if (retries > 0) {
                            await sleep(backoffMs);
                            backoffMs *= 2; 
                        }
                    } else if (status === 404) {
                        break; // Move to next backup model
                    } else {
                        retries--;
                        if (retries > 0) await sleep(backoffMs);
                    }
                }
            }
        }

        if (!responseText) {
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    reply: "I am experiencing heavy network congestion right now and my backup servers are also busy. Please try again in a minute." 
                })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ reply: responseText })
        };

    } catch (error) {
        console.error("Critical Function error:", error);
        return {
            statusCode: 500, // Return 500 only for actual code crashes, not API busyness
            body: JSON.stringify({ error: error.message })
        };
    }
};
