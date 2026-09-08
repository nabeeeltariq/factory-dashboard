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
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // 3. The Strict Factory System Prompt
        const systemPrompt = `You are a data analyst for a Unilever factory floor. 
        Analyze the following Firebase JSON shift history.
        
        Rules:
        - Answer the user's questions clearly and concisely.
        - If the user asks for a graph or chart (e.g., "show me a bar chart of last 7 days production"), 
          you MUST output a raw JSON block wrapped in \`\`\`json and \`\`\` markers containing a Chart.js configuration object.
        
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
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
