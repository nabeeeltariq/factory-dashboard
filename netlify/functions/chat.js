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
        const historyData = await fbRes.json();

        // 2. Initialize Gemini securely
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        // 3. The Strict Factory System Prompt
        const systemPrompt = `You are a data analyst for a Unilever factory floor.
Analyze the following Firebase JSON shift history.

Rules:
- ALWAYS be extremely concise and answer straight to the point.
- If the user asks a general question (e.g., "tell me August production"), provide ONLY the final total numbers (total cases, total tons) in 1 or 2 short sentences. Do NOT list daily or shift-by-shift details unless explicitly requested.
- If a shift record contains the flag "source": "legacy_manual", explicitly mention that this record is from historical manual entries, so no breakdown or exact shift-timing metrics are available. Provide only the date, variant, cases, and tonnage.
- If the user asks for a graph or chart, you MUST output a raw JSON block wrapped in \`\`\`json and \`\`\` markers containing a Chart.js configuration object.

Data context: ${JSON.stringify(historyData)}`;

        // 4. Robust Retry with Timeout Protection
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
