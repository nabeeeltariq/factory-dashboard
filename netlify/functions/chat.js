const { GoogleGenerativeAI } = require("@google/generative-ai");

exports.handler = async function(event, context) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { message } = JSON.parse(event.body);
        
        // 1. Fetch recent shift data from Firebase
        const firebaseURL = "https://automation-60207-default-rtdb.firebaseio.com/shift_history.json";
        const fbRes = await fetch(firebaseURL);
        const historyData = await fbRes.json();

        // 2. Initialize Gemini securely using Environment Variables
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

     // 3. The Strict Factory System Prompt
const systemPrompt = `You are a data analyst for a Unilever factory floor.
Analyze the following Firebase JSON shift history.

Rules:
- ALWAYS be extremely concise and answer straight to the point.
- If the user asks a general question (e.g., "tell me August production"), provide ONLY the final total numbers (total cases, total tons) in 1 or 2 short sentences. Do NOT list daily or shift-by-shift details unless explicitly requested.
- If a shift record contains the flag "source": "legacy_manual", explicitly mention that this record is from historical manual entries, so no breakdown or exact shift-timing metrics are available. Provide only the date, variant, cases, and tonnage.
- If the user asks for a graph or chart, you MUST output a raw JSON block wrapped in \`\`\`json and \`\`\` markers containing a Chart.js configuration object.

Data context: ${JSON.stringify(historyData)}`;
      // 4. Generate the response
        const result = await model.generateContent([systemPrompt, message]);
        const responseText = result.response.text();

        return {
            statusCode: 200,
            body: JSON.stringify({ reply: responseText })
        };

    } catch (error) {
        console.error("Function error:", error);
        
        // If Google's servers are busy, send this friendly message back to the chat widget instead of crashing
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                reply: "My server is experiencing a brief moment of high traffic. Please wait a few seconds and ask me again!" 
            })
        };
    }
};
