const { onRequest } = require("firebase-functions/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

// Visitor Counter + Admin Logs + Feedback endpoint
exports.counter = onRequest(
  { 
    cors: true,
    invoker: "public"
  },
  async (req, res) => {

    // ── Admin logs: GET /counter?action=logs ─────────────────────────────────
    if (req.method === "GET" && req.query.action === "logs") {
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
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
        const todayCount = logs.filter(l => l.timestamp && new Date(l.timestamp) >= todayStart).length;
        const weekCount = logs.filter(l => l.timestamp && new Date(l.timestamp) >= weekStart).length;
        const eraCounts = {};
        logs.forEach(l => { if (l.era) eraCounts[l.era] = (eraCounts[l.era] || 0) + 1; });
        const topEra = Object.entries(eraCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
        return res.json({ total: logs.length, today: todayCount, thisWeek: weekCount, topEra, logs });
      } catch (error) {
        logger.error("getLogs error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Admin logs: POST /counter?action=clearLogs ───────────────────────────
    if (req.method === "POST" && req.query.action === "clearLogs") {
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

    // ── Feedback: POST /counter?action=feedback ──────────────────────────────
    // Saves a user bug report or feature request to Firestore.
    if (req.method === "POST" && req.query.action === "feedback") {
      try {
        const { text, type, sessionDate, context } = req.body || {};

        if (!text || typeof text !== "string" || text.trim().length < 3) {
          return res.status(400).json({ error: "Feedback text is required." });
        }

        // Soft rate limit: 3 reports per IP per hour
        const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        // Single-field query only (avoids composite index requirement)
        const recentSnap = await db.collection("feedbackReports")
          .where("ip", "==", ip)
          .limit(10)
          .get();
        const recentCount = recentSnap.docs.filter(doc => {
          const ts = doc.data().timestamp?.toDate?.();
          return ts && ts >= oneHourAgo;
        }).length;
        if (recentCount >= 3) {
          return res.status(429).json({ error: "Too many reports. Please wait an hour before submitting again." });
        }

        const reportType = type === "feature" ? "feature" : "bug";
        await db.collection("feedbackReports").add({
          text: text.trim().substring(0, 2000),
          type: reportType,
          sessionDate: sessionDate || null,
          context: context || null,
          ip,
          userAgent: req.headers["user-agent"] || null,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "pending"   // pending | reviewed | implemented | dismissed
        });

        logger.info("Feedback saved", { type: reportType, ip });

        // ── Auto-trigger: check if threshold is now crossed ───────────────────
        // Run async so we don't delay the user's response
        (async () => {
          try {
            // Get threshold from Firestore settings
            const settingsDoc = await db.collection("config").doc("settings").get();
            const threshold = settingsDoc.exists ? (settingsDoc.data().threshold || 5) : 5;

            // Don't re-trigger if beta already pending review or published
            const betaDoc = await db.collection("config").doc("betaVersion").get();
            if (betaDoc.exists) {
              const betaStatus = betaDoc.data().status;
              if (betaStatus === "pending_review" || betaStatus === "published") {
                logger.info("Auto-trigger skipped: beta already exists", { betaStatus });
                return;
              }
            }

            // Count pending reports of the saved type
            const allSnap = await db.collection("feedbackReports")
              .where("type", "==", reportType)
              .where("status", "==", "pending")
              .get();
            const pendingCount = allSnap.size;

            logger.info("Auto-trigger check", { reportType, pendingCount, threshold });

            if (pendingCount < threshold) return; // not yet

            // Threshold crossed — collect reports and run analysis
            logger.info("Auto-trigger FIRING", { reportType, pendingCount });

            const reports = [];
            allSnap.forEach(doc => {
              const d = doc.data();
              reports.push({
                id: doc.id,
                text: d.text,
                type: d.type,
                timestamp: d.timestamp?.toDate?.()?.toISOString() || null
              });
            });

            // Fetch current index.html
            const siteRes = await fetch(
              "https://raw.githubusercontent.com/bruceinpb/oldtimeyai/main/public/index.html"
            );
            if (!siteRes.ok) throw new Error(`Could not fetch index.html: ${siteRes.status}`);
            const currentHtml = await siteRes.text();

            const reportsText = reports.map((r, i) =>
              `Report ${i + 1} (${r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "unknown"}): ${r.text}`
            ).join("\n");

            const prompt = `You are an expert web developer maintaining OldTimeyAI (oldtimeyai.com), a steampunk-themed historical AI chat website.

The AutoPilot system has automatically detected that ${reports.length} user ${reportType} report(s) have crossed the action threshold. Your job is to:
1. Read all the reports carefully
2. Group similar/related reports together
3. Diagnose the root cause(s)
4. Implement ALL the fixes/features directly into the provided HTML
5. Return the complete updated HTML file

USER REPORTS (${reportType}s):
${reportsText}

CURRENT index.html:
${currentHtml}

INSTRUCTIONS:
- Implement every reasonable request. If multiple reports describe the same issue, fix it once.
- Preserve ALL existing functionality — do not remove features.
- Keep the steampunk/vintage aesthetic.
- Your response must be in this EXACT format with no deviation:

DIAGNOSIS:
[2-5 sentences explaining what you found, grouped by theme, and what you changed]

HTML:
[The complete updated index.html file, starting with <!DOCTYPE html> and ending with </html>]`;

            const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": anthropicApiKey.value(),
                "anthropic-version": "2023-06-01"
              },
              body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 8192,
                messages: [{ role: "user", content: prompt }]
              })
            });

            if (!claudeRes.ok) throw new Error(`Claude API error: ${claudeRes.status}`);

            const claudeData = await claudeRes.json();
            const fullResponse = claudeData.content[0].text;

            const diagMatch = fullResponse.match(/DIAGNOSIS:\s*([\s\S]*?)(?=\nHTML:)/i);
            const htmlMatch = fullResponse.match(/HTML:\s*(<!DOCTYPE[\s\S]*<\/html>)/i);

            if (!htmlMatch) throw new Error("Claude did not return valid HTML.");

            const diagnosis = diagMatch ? diagMatch[1].trim() : "Auto-generated fix.";
            const html      = htmlMatch[1].trim();

            // Save as pending_review — admin must approve before it goes live
            await db.collection("config").doc("betaVersion").set({
              html,
              diagnosis,
              type: reportType,
              reportCount: reports.length,
              status: "pending_review",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              promotedAt: null,
              autoTriggered: true
            });

            logger.info("Auto-trigger complete: beta saved as pending_review", { reportType, htmlLength: html.length });

          } catch (autoErr) {
            logger.error("Auto-trigger error", { message: autoErr.message });
          }
        })();

        return res.json({ ok: true });
      } catch (error) {
        logger.error("saveFeedback error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Feedback: GET /counter?action=feedback ───────────────────────────────
    // Returns all feedback reports for the admin panel.
    if (req.method === "GET" && req.query.action === "feedback") {
      try {
        const limit = parseInt(req.query.limit) || 500;
        const snapshot = await db.collection("feedbackReports")
          .orderBy("timestamp", "desc")
          .limit(limit)
          .get();
        const reports = [];
        snapshot.forEach(doc => {
          const d = doc.data();
          reports.push({
            id: doc.id,
            text: d.text,
            type: d.type,
            sessionDate: d.sessionDate,
            status: d.status,
            timestamp: d.timestamp?.toDate?.()?.toISOString() || null,
            ip: d.ip,
            userAgent: d.userAgent
          });
        });

        // Summary counts
        const bugCount     = reports.filter(r => r.type === "bug").length;
        const featureCount = reports.filter(r => r.type === "feature").length;
        const pendingCount = reports.filter(r => r.status === "pending").length;

        return res.json({ total: reports.length, bugCount, featureCount, pendingCount, reports });
      } catch (error) {
        logger.error("getFeedback error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Feedback: POST /counter?action=updateFeedbackStatus ─────────────────
    // Updates the status of a feedback report (reviewed / implemented / dismissed).
    if (req.method === "POST" && req.query.action === "updateFeedbackStatus") {
      try {
        const { id, status } = req.body || {};
        const validStatuses = ["pending", "reviewed", "implemented", "dismissed"];
        if (!id || !validStatuses.includes(status)) {
          return res.status(400).json({ error: "Invalid id or status." });
        }
        await db.collection("feedbackReports").doc(id).update({ status });
        return res.json({ ok: true });
      } catch (error) {
        logger.error("updateFeedbackStatus error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Beta: GET /counter?action=getBeta ────────────────────────────────────
    // Returns current beta version doc (html + metadata) or null
    if (req.method === "GET" && req.query.action === "getBeta") {
      try {
        const doc = await db.collection("config").doc("betaVersion").get();
        if (!doc.exists) return res.json({ exists: false });
        const d = doc.data();
        return res.json({
          exists: true,
          html: d.html,
          diagnosis: d.diagnosis,
          type: d.type,
          reportCount: d.reportCount,
          createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
          promotedAt: d.promotedAt?.toDate?.()?.toISOString() || null,
          status: d.status   // "pending_review" | "published" | "promoted" | "reverted"
        });
      } catch (error) {
        logger.error("getBeta error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Beta: POST /counter?action=publishBeta ────────────────────────────────
    // Saves generated HTML + metadata as the beta version, status = "published"
    if (req.method === "POST" && req.query.action === "publishBeta") {
      try {
        const { html, diagnosis, type, reportCount } = req.body || {};
        if (!html || typeof html !== "string" || html.length < 100) {
          return res.status(400).json({ error: "Missing or invalid html." });
        }
        await db.collection("config").doc("betaVersion").set({
          html,
          diagnosis: diagnosis || "",
          type: type || "mixed",
          reportCount: reportCount || 0,
          status: "published",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          promotedAt: null
        });
        logger.info("Beta version published", { type, reportCount });
        return res.json({ ok: true });
      } catch (error) {
        logger.error("publishBeta error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Beta: POST /counter?action=promoteBeta ───────────────────────────────
    // Promotes beta to stable: copies beta html into config/stableVersion
    if (req.method === "POST" && req.query.action === "promoteBeta") {
      try {
        const betaDoc = await db.collection("config").doc("betaVersion").get();
        if (!betaDoc.exists) return res.status(404).json({ error: "No beta version exists." });
        const betaData = betaDoc.data();
        // Save current beta as new stable
        await db.collection("config").doc("stableVersion").set({
          html: betaData.html,
          promotedFrom: "beta",
          promotedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        // Mark beta as promoted
        await db.collection("config").doc("betaVersion").update({
          status: "promoted",
          promotedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        logger.info("Beta promoted to stable");
        return res.json({ ok: true });
      } catch (error) {
        logger.error("promoteBeta error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Beta: POST /counter?action=clearBeta ─────────────────────────────────
    // Removes beta version — beta button goes grey again on site
    if (req.method === "POST" && req.query.action === "clearBeta") {
      try {
        await db.collection("config").doc("betaVersion").delete();
        logger.info("Beta version cleared");
        return res.json({ ok: true });
      } catch (error) {
        logger.error("clearBeta error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Analyze: POST /counter?action=analyze ────────────────────────────────
    // Server-side: fetches current index.html, calls Claude, returns diagnosis+html.
    // Also called internally by the auto-trigger when feedback threshold is crossed.
    if (req.method === "POST" && req.query.action === "analyze") {
      try {
        const { reports, type } = req.body || {};
        if (!reports || !Array.isArray(reports) || reports.length === 0) {
          return res.status(400).json({ error: "No reports provided." });
        }

        // Fetch current index.html server-side (no CORS issues here)
        const siteRes = await fetch(
          "https://raw.githubusercontent.com/bruceinpb/oldtimeyai/main/public/index.html"
        );
        if (!siteRes.ok) throw new Error(`Could not fetch index.html: ${siteRes.status}`);
        const currentHtml = await siteRes.text();

        const reportsText = reports.map((r, i) =>
          `Report ${i + 1} (${r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "unknown"}): ${r.text}`
        ).join("\n");

        const prompt = `You are an expert web developer maintaining OldTimeyAI (oldtimeyai.com), a steampunk-themed historical AI chat website.

The admin has collected ${reports.length} user ${type} report(s) that have crossed the AutoPilot threshold. Your job is to:
1. Read all the reports carefully
2. Group similar/related reports together
3. Diagnose the root cause(s)
4. Implement ALL the fixes/features directly into the provided HTML
5. Return the complete updated HTML file

USER REPORTS (${type}s):
${reportsText}

CURRENT index.html:
${currentHtml}

INSTRUCTIONS:
- Implement every reasonable request. If multiple reports describe the same issue, fix it once.
- Preserve ALL existing functionality — do not remove features.
- Keep the steampunk/vintage aesthetic.
- Your response must be in this EXACT format with no deviation:

DIAGNOSIS:
[2-5 sentences explaining what you found, grouped by theme, and what you changed]

HTML:
[The complete updated index.html file, starting with <!DOCTYPE html> and ending with </html>]`;

        logger.info("Running AutoPilot analysis", { type, reportCount: reports.length });

        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicApiKey.value(),
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 8192,
            messages: [{ role: "user", content: prompt }]
          })
        });

        if (!claudeRes.ok) {
          const err = await claudeRes.text();
          logger.error("Claude API error in analyze", { status: claudeRes.status, err });
          throw new Error(`Claude API error: ${claudeRes.status}`);
        }

        const claudeData = await claudeRes.json();
        const fullResponse = claudeData.content[0].text;

        const diagMatch = fullResponse.match(/DIAGNOSIS:\s*([\s\S]*?)(?=\nHTML:)/i);
        const htmlMatch = fullResponse.match(/HTML:\s*(<!DOCTYPE[\s\S]*<\/html>)/i);

        if (!htmlMatch) {
          logger.error("Claude did not return valid HTML", { preview: fullResponse.substring(0, 300) });
          throw new Error("Claude did not return valid HTML in the expected format.");
        }

        const diagnosis = diagMatch ? diagMatch[1].trim() : "Analysis complete.";
        const html      = htmlMatch[1].trim();

        logger.info("AutoPilot analysis complete", { type, diagLength: diagnosis.length, htmlLength: html.length });
        return res.json({ ok: true, diagnosis, html, reportCount: reports.length, type });

      } catch (error) {
        logger.error("analyze error", { message: error.message, stack: error.stack });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Settings: GET /counter?action=getSettings ─────────────────────────────
    if (req.method === "GET" && req.query.action === "getSettings") {
      try {
        const doc = await db.collection("config").doc("settings").get();
        const threshold = doc.exists ? (doc.data().threshold || 5) : 5;
        return res.json({ threshold });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Settings: POST /counter?action=saveSettings ───────────────────────────
    if (req.method === "POST" && req.query.action === "saveSettings") {
      try {
        const { threshold } = req.body || {};
        const val = parseInt(threshold);
        if (isNaN(val) || val < 1) return res.status(400).json({ error: "Invalid threshold." });
        await db.collection("config").doc("settings").set({ threshold: val }, { merge: true });
        return res.json({ ok: true, threshold: val });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Default: visitor counter ─────────────────────────────────────────────
    try {
      const counterRef = db.collection("stats").doc("visitors");
      
      if (req.method === "POST") {
        const { setCount } = req.body || {};
        if (setCount !== undefined) {
          await counterRef.set({ count: parseInt(setCount) });
        } else {
          await counterRef.set(
            { count: admin.firestore.FieldValue.increment(1) },
            { merge: true }
          );
        }
      }
      
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
    secrets: [anthropicApiKey],
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
          "x-api-key": anthropicApiKey.value(),
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
    secrets: [anthropicApiKey],
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
          "x-api-key": anthropicApiKey.value(),
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
    secrets: [anthropicApiKey],
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
          "x-api-key": anthropicApiKey.value(),
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
