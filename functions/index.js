const { onRequest } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();


// Visitor Counter endpoint
exports.counter = onRequest(
  { 
    cors: true,
    invoker: "public"
  },
  async (req, res) => {
    try {
      const counterRef = db.collection("stats").doc("visitors");
      
      if (req.method === "POST") {
        const { setCount } = req.body || {};
        
        if (setCount !== undefined) {
          // Set to specific value
          await counterRef.set({ count: parseInt(setCount) });
        } else {
          // Increment the counter
          await counterRef.set(
            { count: admin.firestore.FieldValue.increment(1) },
            { merge: true }
          );
        }
      }
      
      // Get current count
      const doc = await counterRef.get();
      const count = doc.exists ? doc.data().count : 0;
      
      return res.json({ count });
    } catch (error) {
      logger.error("Counter error", { message: error.message });
      return res.status(500).json({ error: error.message });
    }
  }
);

// Historical Events endpoint
exports.events = onRequest(
  { 
    cors: true,
    invoker: "public"
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { cutoffDate } = req.body;

      if (!cutoffDate) {
        return res.status(400).json({ error: "Missing cutoffDate" });
      }

      const { month, day, year } = cutoffDate;
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const formattedDate = `${monthNames[month - 1]} ${day}, ${year}`;

      const prompt = `For the date ${formattedDate}, provide exactly 5 significant historical events that occurred on or very close to this date (within the same month if necessary). 

For each event, also identify ONE major invention, discovery, technology, or world-changing event that would occur within the next 1-12 months after ${formattedDate}. This "coming soon" item should be something the people of that time would have NO knowledge of yet.

Respond in this exact JSON format only, with no additional text:
{
  "events": [
    {
      "id": 1,
      "title": "Brief event title (5-8 words)",
      "date": "Month Day, Year",
      "summary": "A compelling 2-3 sentence summary of the event written in an engaging, professional journalistic style."
    }
  ],
  "comingSoon": {
    "title": "Name of the upcoming invention/discovery/event",
    "timeframe": "In X weeks/months",
    "teaser": "A tantalizing 2-3 sentence hint about what's coming, written as if whispering a secret from the future. Make it dramatic and emphasize how this will change everything. Do not reveal you are from the future - write it as prophetic foreshadowing."
  }
}

Focus on genuinely significant events - wars, treaties, scientific discoveries, political changes, cultural milestones, natural disasters, famous births/deaths. Be historically accurate.`;

      logger.info("Fetching historical events", { date: formattedDate });

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2048,
          messages: [{
            role: "user",
            content: prompt
          }]
        })
      });

      const responseText = await response.text();

      if (!response.ok) {
        logger.error("Claude API error", { status: response.status, body: responseText });
        return res.status(500).json({ error: "AI service error" });
      }

      const data = JSON.parse(responseText);
      const content = data.content[0].text;
      
      // Parse the JSON from Claude's response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error("Could not parse events JSON", { content });
        return res.status(500).json({ error: "Failed to parse events" });
      }
      
      const eventsData = JSON.parse(jsonMatch[0]);
      return res.json(eventsData);

    } catch (error) {
      logger.error("Function error", { message: error.message, stack: error.stack });
      return res.status(500).json({ error: error.message });
    }
  }
);

// Event Story endpoint
exports.story = onRequest(
  { 
    cors: true,
    invoker: "public"
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { event, cutoffDate } = req.body;

      if (!event || !cutoffDate) {
        return res.status(400).json({ error: "Missing event or cutoffDate" });
      }

      const { month, day, year } = cutoffDate;
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const formattedDate = `${monthNames[month - 1]} ${day}, ${year}`;

      const prompt = `Write a compelling, well-researched article about the following historical event: "${event.title}" which occurred on ${event.date}.

Write in an engaging, professional journalistic style suitable for a history magazine. The article should be approximately 300-400 words and include:

1. The key facts and context of the event
2. The major figures involved
3. The immediate impact and significance
4. How this event shaped what came after (but only mention things that would have been known by ${formattedDate})

Write as if you are a historian in ${year}, with no knowledge of events after ${formattedDate}. Use period-appropriate language and perspectives.

End with a thought-provoking reflection on the significance of this moment in history.`;

      logger.info("Generating story", { event: event.title });

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: prompt
          }]
        })
      });

      const responseText = await response.text();

      if (!response.ok) {
        logger.error("Claude API error", { status: response.status, body: responseText });
        return res.status(500).json({ error: "AI service error" });
      }

      const data = JSON.parse(responseText);
      return res.json({ story: data.content[0].text });

    } catch (error) {
      logger.error("Function error", { message: error.message, stack: error.stack });
      return res.status(500).json({ error: error.message });
    }
  }
);

// Chat endpoint
exports.chat = onRequest(
  { 
    cors: true,
    invoker: "public"
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { cutoffDate, messages } = req.body;

      if (!cutoffDate || !messages) {
        return res.status(400).json({ error: "Missing cutoffDate or messages" });
      }

      const { month, day, year } = cutoffDate;
      const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const formattedDate = `${monthNames[month - 1]} ${day}, ${year}`;

      const systemPrompt = `You are "Old Timey AI," a knowledgeable assistant with a charming, old-fashioned manner of speaking. Your knowledge is LIMITED to events, discoveries, inventions, and information available up to and including ${formattedDate}.

CRITICAL RULES:
1. You must NEVER reference, acknowledge, or discuss anything that happened AFTER ${formattedDate}.
2. If asked about events after your cutoff date, respond with genuine confusion - you simply have no knowledge of such things.
3. Speak in a warm, slightly formal, Victorian-era style with occasional old-fashioned expressions.
4. Show enthusiasm for the knowledge and discoveries of your time period.
5. If someone mentions something from the future, be puzzled and curious, but maintain that you have no knowledge of it.
6. Stay in character at all times - you ARE from ${formattedDate}.

Remember: The current date for you is ${formattedDate}. Anything after this date simply hasn't happened yet in your world.`;

      logger.info("Calling Claude API", { messageCount: messages.length });

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: systemPrompt,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content
          }))
        })
      });

      const responseText = await response.text();
      logger.info("Claude response status", { status: response.status });

      if (!response.ok) {
        logger.error("Claude API error", { status: response.status, body: responseText });
        return res.status(500).json({ error: "AI service error", details: responseText });
      }

      const data = JSON.parse(responseText);
      const aiResponse = data.content[0].text;

      // Save exchange to Firestore for admin logging
      try {
        const userMessage = messages[messages.length - 1];
        await db.collection("chatLogs").add({
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          cutoffDate: formattedDate,
          era: year,
          userMessage: userMessage ? userMessage.content : "",
          aiResponse: aiResponse,
          messageCount: messages.length
        });
      } catch (logError) {
        logger.error("Failed to save chat log", { message: logError.message });
        // Don't fail the request if logging fails
      }

      return res.json({ response: aiResponse });

    } catch (error) {
      logger.error("Function error", { message: error.message, stack: error.stack });
      return res.status(500).json({ error: error.message });
    }
  }
);

// Admin: Get Chat Logs
exports.getLogs = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 200;
      const snapshot = await db.collection("chatLogs")
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();

      const logs = [];
      snapshot.forEach(doc => {
        const d = doc.data();
        logs.push({
          id: doc.id,
          timestamp: d.timestamp?.toDate?.()?.toISOString() || null,
          cutoffDate: d.cutoffDate,
          era: d.era,
          userMessage: d.userMessage,
          aiResponse: d.aiResponse,
          messageCount: d.messageCount
        });
      });

      // Stats
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      const todayCount = logs.filter(l => l.timestamp && new Date(l.timestamp) >= todayStart).length;
      const weekCount = logs.filter(l => l.timestamp && new Date(l.timestamp) >= weekStart).length;

      // Top era
      const eraCounts = {};
      logs.forEach(l => { if (l.era) eraCounts[l.era] = (eraCounts[l.era] || 0) + 1; });
      const topEra = Object.entries(eraCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

      return res.json({ total: logs.length, today: todayCount, thisWeek: weekCount, topEra, logs });
    } catch (error) {
      logger.error("getLogs error", { message: error.message });
      return res.status(500).json({ error: error.message });
    }
  }
);

// Admin: Clear Chat Logs
exports.clearLogs = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method !== "DELETE" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      const snapshot = await db.collection("chatLogs").limit(500).get();
      const batch = db.batch();
      snapshot.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      return res.json({ deleted: snapshot.size });
    } catch (error) {
      logger.error("clearLogs error", { message: error.message });
      return res.status(500).json({ error: error.message });
    }
  }
);
