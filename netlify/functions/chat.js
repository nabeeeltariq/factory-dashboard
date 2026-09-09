const { GoogleGenerativeAI } = require("@google/generative-ai");

// Helper Function: Sleep with random "jitter" to avoid server traffic clashes
const sleep = (ms) => new Promise((resolve) => {
    const jitter = Math.floor(Math.random() * 500); 
    setTimeout(resolve, ms + jitter);
});

exports.handler = async function(event, context) {
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

        // 4. Robust Retry & Fallback Configuration
        const modelsToTry = ["gemini-3.6-flash", "gemini-1.5-flash", "gemini-pro"];
        let responseText = null;
        let lastError = null;

        // Outer loop: Try different backup models
        for (const modelName of modelsToTry) {
            if (responseText) break; // Stop immediately if we got a successful answer

            const model = genAI.getGenerativeModel({ model: modelName });
            let retries = 3; // Max attempts per model
            let backoffMs = 1500; // Start with a 1.5 second wait

            // Inner loop: Retry the current model if the server is busy
            while (retries > 0) {
                try {
                    const result = await model.generateContent([systemPrompt, message]);
                    responseText = result.response.text();
                    console.log(`Success using model: ${modelName}`);
                    break; // Break the retry loop on success
                } catch (error) {
                    lastError = error;
                    const status = error.status || (error.response && error.response.status);

                    // If it's a 503 (Busy) or 429 (Rate Limit), apply exponential backoff
                    if (status === 503 || status === 429) {
                        console.warn(`[${modelName}] API Busy (${status}). Retries left: ${retries - 1}. Waiting ${backoffMs}ms...`);
                        retries--;
                        await sleep(backoffMs);
                        backoffMs *= 2; // Exponential backoff (1.5s -> 3s -> 6s)
                    }
                    // If it's a 404 (Model Not Found), immediately break and try the backup model
                    else if (status === 404) {
                        console.warn(`[${modelName}] Not found (404). Switching to backup model...`);
                        break;
                    }
                    // For any other unexpected error, wait briefly then retry
                    else {
                        retries--;
                        await sleep(backoffMs);
                    }
                }
            }
        }

        // 5. Final Check & Return
        if (!responseText) {
            // If every single model and every retry failed
            console.error("All models and retries failed. Last error:", lastError);
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    reply: "I am experiencing heavy network congestion right now. I've tried my backup systems but still couldn't connect. Please try again in a minute." 
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
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
