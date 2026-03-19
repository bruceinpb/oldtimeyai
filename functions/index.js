const { onRequest } = require("firebase-functions/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const githubPat       = defineSecret("GITHUB_PAT");


// ── AutoPilot: shared prompt builder and patch applier ────────────────────────
function buildAutoPilotPrompt(reports, type, currentHtml) {
  const reportsText = reports.map((r, i) =>
    `Report ${i + 1} (${r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "unknown"}): ${r.text}`
  ).join("\n");

  return `You are an expert web developer maintaining OldTimeyAI (oldtimeyai.com), a steampunk-themed historical AI chat website.

The AutoPilot system has detected that ${reports.length} user ${type} report(s) have crossed the action threshold.

USER REPORTS (${type}s):
${reportsText}

CURRENT index.html (${currentHtml.length} bytes):
${currentHtml}

YOUR TASK:
1. Read all reports carefully and group similar ones
2. Diagnose the root cause(s)
3. Implement the fixes/features in the HTML

RESPONSE FORMAT — you MUST use exactly this format:

DIAGNOSIS:
[2-5 sentences explaining what you found and what you changed]

PATCHES:
[One or more patches in this exact format — repeat as needed:]
<<<FIND>>>
[exact text from the current HTML to find — minimum 3 unique lines]
<<<REPLACE>>>
[replacement text]
<<<END>>>

RULES:
- Each FIND block must be UNIQUE in the HTML — include enough context lines
- Do NOT return the full HTML file — only the changed sections as patches
- Do NOT use markdown code fences
- Each patch replaces exactly the FIND text with the REPLACE text
- If adding something new, include the surrounding anchor lines in FIND`;
}

function applyPatches(html, fullResponse) {
  // Extract patches from response
  const patchRegex = /<<<FIND>>>\n([\s\S]*?)<<<REPLACE>>>\n([\s\S]*?)<<<END>>>/g;
  let patched = html;
  let patchCount = 0;
  let match;
  const errors = [];

  while ((match = patchRegex.exec(fullResponse)) !== null) {
    const findText   = match[1];
    const replaceText = match[2];
    
    if (patched.includes(findText)) {
      patched = patched.replace(findText, replaceText);
      patchCount++;
    } else {
      // Try trimmed version
      const findTrimmed = findText.trim();
      if (patched.includes(findTrimmed)) {
        patched = patched.replace(findTrimmed, replaceText.trim());
        patchCount++;
      } else {
        errors.push(`Patch not applied — FIND text not found: ${findText.substring(0,80)}...`);
      }
    }
  }

  return { patched, patchCount, errors };
}


// Visitor Counter + Admin Logs + Feedback endpoint
exports.counter = onRequest(
  { 
    cors: true,
    invoker: "public",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [anthropicApiKey, githubPat]
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

        // Rate limit: read from Firestore settings (default 3, admin-configurable up to 60)
        const rlSettingsDoc = await db.collection("config").doc("settings").get();
        const rateLimit = Math.min(60, Math.max(1, rlSettingsDoc.exists ? (rlSettingsDoc.data().rateLimit || 3) : 3));

        // Soft rate limit: N reports per IP per hour
        const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        // Single-field query only (avoids composite index requirement)
        const recentSnap = await db.collection("feedbackReports")
          .where("ip", "==", ip)
          .limit(60)
          .get();
        const recentCount = recentSnap.docs.filter(doc => {
          const ts = doc.data().timestamp?.toDate?.();
          return ts && ts >= oneHourAgo;
        }).length;
        if (recentCount >= rateLimit) {
          return res.status(429).json({ error: `Too many reports. You can submit up to ${rateLimit} per hour. Please wait and try again.` });
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
        // We write a queue doc to Firestore — the admin panel polls for it
        // and calls ?action=analyze when it sees one. This avoids running
        // the long Claude call inside this short-lived request.
        (async () => {
          try {
            const settingsDoc = await db.collection("config").doc("settings").get();
            const threshold = settingsDoc.exists ? (settingsDoc.data().threshold || 5) : 5;

            // Don't re-queue if beta already exists or queue already pending
            const betaDoc = await db.collection("config").doc("betaVersion").get();
            if (betaDoc.exists) {
              const s = betaDoc.data().status;
              if (s === "pending_review" || s === "published" || s === "queued") return;
            }
            const queueDoc = await db.collection("config").doc("analysisQueue").get();
            if (queueDoc.exists && queueDoc.data().status === "queued") return;

            // Count pending reports of the saved type
            const allSnap = await db.collection("feedbackReports")
              .where("type", "==", reportType)
              .where("status", "==", "pending")
              .get();
            const pendingCount = allSnap.size;

            logger.info("Auto-trigger check", { reportType, pendingCount, threshold });
            if (pendingCount < threshold) return;

            // Threshold crossed — write queue doc; admin panel will pick it up
            logger.info("Auto-trigger: writing analysisQueue", { reportType, pendingCount });
            await db.collection("config").doc("analysisQueue").set({
              status: "queued",
              type: reportType,
              reportCount: pendingCount,
              queuedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } catch (autoErr) {
            logger.error("Auto-trigger queue error", { message: autoErr.message });
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

        // Summary counts — pending only, so the admin threshold reflects actionable items
        const bugCount     = reports.filter(r => r.type === "bug"     && r.status === "pending").length;
        const featureCount = reports.filter(r => r.type === "feature" && r.status === "pending").length;
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
    // Also atomically marks all pending reports of the analyzed type as "reviewed"
    // so bug/feature counters reset to zero immediately.
    if (req.method === "POST" && req.query.action === "publishBeta") {
      try {
        const { html, diagnosis, type, reportCount } = req.body || {};
        if (!html || typeof html !== "string" || html.length < 100) {
          return res.status(400).json({ error: "Missing or invalid html." });
        }

        // Mark all pending reports of this type as "reviewed" — server-side so it
        // works regardless of whether the admin client has allFeedback loaded.
        let markedCount = 0;
        if (type && type !== "mixed") {
          const pendingSnap = await db.collection("feedbackReports")
            .where("status", "==", "pending")
            .where("type", "==", type)
            .get();
          const batch = db.batch();
          pendingSnap.forEach(doc => {
            batch.update(doc.ref, { status: "reviewed" });
            markedCount++;
          });
          if (markedCount > 0) await batch.commit();
          logger.info("publishBeta: marked reports reviewed", { type, markedCount });
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
        logger.info("Beta version published", { type, reportCount, markedCount });
        return res.json({ ok: true, markedCount });
      } catch (error) {
        logger.error("publishBeta error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Beta: POST /counter?action=promoteBeta ───────────────────────────────
    // Promotes beta to stable: pushes beta HTML to GitHub as public/index.html
    // via the GitHub API, triggering the CI/CD deploy pipeline automatically.
    if (req.method === "POST" && req.query.action === "promoteBeta") {
      try {
        const betaDoc = await db.collection("config").doc("betaVersion").get();
        if (!betaDoc.exists) return res.status(404).json({ error: "No beta version exists." });
        const betaData = betaDoc.data();
        const betaHtml = betaData.html;
        if (!betaHtml || betaHtml.length < 100) {
          return res.status(400).json({ error: "Beta HTML is empty or invalid." });
        }

        const pat = githubPat.value();
        if (!pat) return res.status(500).json({ error: "GITHUB_PAT secret not configured." });

        // Step 1: Get current SHA of index.html in GitHub (required for update API)
        const shaRes = await fetch(
          "https://api.github.com/repos/bruceinpb/oldtimeyai/contents/public/index.html",
          { headers: { "Authorization": `token ${pat}`, "User-Agent": "OldTimeyAI-AutoPilot" } }
        );
        if (!shaRes.ok) throw new Error(`GitHub SHA fetch failed: ${shaRes.status}`);
        const shaData = await shaRes.json();
        const currentSha = shaData.sha;
        if (!currentSha) throw new Error("Could not get current file SHA from GitHub.");

        // Step 2: Push beta HTML as new stable index.html
        const content = Buffer.from(betaHtml).toString("base64");
        const pushRes = await fetch(
          "https://api.github.com/repos/bruceinpb/oldtimeyai/contents/public/index.html",
          {
            method: "PUT",
            headers: {
              "Authorization": `token ${pat}`,
              "Content-Type": "application/json",
              "User-Agent": "OldTimeyAI-AutoPilot"
            },
            body: JSON.stringify({
              message: `promote: AutoPilot beta → stable (${betaData.type}, ${betaData.reportCount} reports)`,
              content,
              sha: currentSha
            })
          }
        );
        if (!pushRes.ok) {
          const err = await pushRes.text();
          throw new Error(`GitHub push failed: ${pushRes.status} — ${err.substring(0, 200)}`);
        }
        const pushData = await pushRes.json();
        const commitSha = pushData.commit?.sha || "unknown";

        // Step 3: Record promotion in Firestore
        await db.collection("config").doc("stableVersion").set({
          html: betaHtml,
          promotedFrom: "beta",
          commitSha,
          promotedAt: admin.firestore.FieldValue.serverTimestamp(),
          type: betaData.type,
          reportCount: betaData.reportCount,
          diagnosis: betaData.diagnosis || ""
        });
        await db.collection("config").doc("betaVersion").update({
          status: "promoted",
          promotedAt: admin.firestore.FieldValue.serverTimestamp(),
          commitSha
        });

        logger.info("Beta promoted to stable via GitHub push", { commitSha, type: betaData.type });
        return res.json({ ok: true, commitSha, message: "Beta pushed to GitHub — CI/CD deploying now." });

      } catch (error) {
        logger.error("promoteBeta error", { message: error.message, stack: error.stack });
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

        const prompt = buildAutoPilotPrompt(reports, type, currentHtml);

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
            max_tokens: 4096,
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

        const diagMatch = fullResponse.match(/DIAGNOSIS:\s*([\s\S]*?)(?=\nPATCHES:)/i);
        const diagnosis = diagMatch ? diagMatch[1].trim() : "Analysis complete.";

        if (!fullResponse.includes("<<<FIND>>>")) {
          logger.error("Claude did not return patches", { preview: fullResponse.substring(0, 300) });
          throw new Error("Claude did not return patches in the expected format.");
        }

        const { patched, patchCount, errors } = applyPatches(currentHtml, fullResponse);
        logger.info("AutoPilot analysis complete", { type, patchCount, errors: errors.length });
        return res.json({ ok: true, diagnosis, html: patched, reportCount: reports.length, type, patchCount, patchErrors: errors });

      } catch (error) {
        logger.error("analyze error", { message: error.message, stack: error.stack });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Settings: GET /counter?action=getSettings ─────────────────────────────
    if (req.method === "GET" && req.query.action === "getSettings") {
      try {
        const doc = await db.collection("config").doc("settings").get();
        const threshold          = doc.exists ? (doc.data().threshold          || 5)  : 5;
        const heartbeatInterval  = doc.exists ? (doc.data().heartbeatInterval  || 5)  : 5;
        const rateLimit          = doc.exists ? (doc.data().rateLimit          || 3)  : 3;
        const lastHeartbeatAt    = doc.exists ? (doc.data().lastHeartbeatAt?.toDate?.()?.toISOString() || null) : null;
        return res.json({ threshold, heartbeatInterval, rateLimit, lastHeartbeatAt });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Settings: POST /counter?action=saveSettings ───────────────────────────
    if (req.method === "POST" && req.query.action === "saveSettings") {
      try {
        const { threshold, heartbeatInterval, rateLimit, resetHeartbeat } = req.body || {};
        const updates = {};
        if (threshold !== undefined) {
          const val = parseInt(threshold);
          if (isNaN(val) || val < 1) return res.status(400).json({ error: "Invalid threshold." });
          updates.threshold = val;
        }
        if (heartbeatInterval !== undefined) {
          const val = parseInt(heartbeatInterval);
          // Allow 5–1440 minutes (1 min minimum tick is every 5min so floor to 5)
          if (isNaN(val) || val < 5 || val > 1440) return res.status(400).json({ error: "Heartbeat interval must be 5–1440 minutes." });
          updates.heartbeatInterval = val;
        }
        if (rateLimit !== undefined) {
          const val = parseInt(rateLimit);
          if (isNaN(val) || val < 1 || val > 60) return res.status(400).json({ error: "Rate limit must be 1–60 reports per hour." });
          updates.rateLimit = val;
        }
        if (resetHeartbeat === true) {
          // Reset the timer so the scheduler won't fire again until the next full interval
          updates.lastHeartbeatAt = admin.firestore.FieldValue.serverTimestamp();
        }
        if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to save." });
        await db.collection("config").doc("settings").set(updates, { merge: true });
        return res.json({ ok: true, ...updates });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Queue: GET /counter?action=getQueue ──────────────────────────────────
    if (req.method === "GET" && req.query.action === "getQueue") {
      try {
        const doc = await db.collection("config").doc("analysisQueue").get();
        if (!doc.exists) return res.json({ queued: false });
        return res.json({ queued: true, ...doc.data(), queuedAt: doc.data().queuedAt?.toDate?.()?.toISOString() || null });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Queue: POST /counter?action=clearQueue ────────────────────────────────
    if (req.method === "POST" && req.query.action === "clearQueue") {
      try {
        await db.collection("config").doc("analysisQueue").delete();
        return res.json({ ok: true });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Heartbeat: POST /counter?action=heartbeat ────────────────────────────
    // Called by Cloud Scheduler every 5 minutes.
    // Synchronous — awaits all work before responding so the Cloud Run
    // container stays alive for the full Claude call (up to 540s timeout).
    // Cloud Scheduler timeout is 10min, well within our function timeout.
    if (req.method === "POST" && req.query.action === "heartbeat") {
      logger.info("AutoPilot heartbeat firing via HTTP");
      try {
        // ── 1. Read settings and enforce configurable interval ─────────────
        const settingsDoc = await db.collection("config").doc("settings").get();
        const threshold         = settingsDoc.exists ? (settingsDoc.data().threshold         || 5) : 5;
        const heartbeatInterval = settingsDoc.exists ? (settingsDoc.data().heartbeatInterval || 5) : 5;
        const lastHeartbeatAt   = settingsDoc.exists ? settingsDoc.data().lastHeartbeatAt    : null;

        if (lastHeartbeatAt) {
          const elapsedMs  = Date.now() - lastHeartbeatAt.toDate().getTime();
          const intervalMs = heartbeatInterval * 60 * 1000;
          if (elapsedMs < intervalMs) {
            logger.info("Heartbeat: skipping — interval not elapsed", {
              heartbeatInterval,
              elapsedMinutes: Math.round(elapsedMs / 60000)
            });
            return res.json({ ok: true, message: "Skipped — interval not elapsed" });
          }
        }

        // Record this run so concurrent invocations skip
        await db.collection("config").doc("settings").set(
          { lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );

        // ── 2. Skip if beta already exists ──────────────────────────────
        const [betaDoc, queueDoc] = await Promise.all([
          db.collection("config").doc("betaVersion").get(),
          db.collection("config").doc("analysisQueue").get()
        ]);
        if (betaDoc.exists) {
          const s = betaDoc.data().status;
          if (s === "pending_review" || s === "published") {
            logger.info("Heartbeat: beta already exists, skipping", { status: s });
            return res.json({ ok: true, message: `Skipped — beta exists (${s})` });
          }
        }
        if (queueDoc.exists) {
          await db.collection("config").doc("analysisQueue").delete();
        }

        // ── 3. Count pending reports ────────────────────────────────────
        const allPendingSnap = await db.collection("feedbackReports")
          .where("status", "==", "pending")
          .get();

        const bugReports = [], featureReports = [];
        allPendingSnap.forEach(doc => {
          const d = doc.data();
          const r = { id: doc.id, text: d.text, type: d.type,
            timestamp: d.timestamp?.toDate?.()?.toISOString() || null };
          if (d.type === "bug")     bugReports.push(r);
          if (d.type === "feature") featureReports.push(r);
        });

        logger.info("Heartbeat counts", { bugs: bugReports.length, features: featureReports.length, threshold });

        let triggerReports = null, triggerType = null;
        if (bugReports.length >= threshold)          { triggerReports = bugReports;     triggerType = "bug"; }
        else if (featureReports.length >= threshold) { triggerReports = featureReports; triggerType = "feature"; }

        if (!triggerReports) {
          logger.info("Heartbeat: threshold not yet reached");
          return res.json({ ok: true, message: "Threshold not yet reached", bugs: bugReports.length, features: featureReports.length, threshold });
        }

        // ── 4. Fetch index.html ──────────────────────────────────────────
        logger.info("Heartbeat: threshold crossed — fetching index.html", { type: triggerType, count: triggerReports.length });
        const siteRes = await fetch("https://raw.githubusercontent.com/bruceinpb/oldtimeyai/main/public/index.html");
        if (!siteRes.ok) throw new Error(`Could not fetch index.html: ${siteRes.status}`);
        const currentHtml = await siteRes.text();

        // ── 5. Call Claude ───────────────────────────────────────────────
        const prompt = buildAutoPilotPrompt(triggerReports, triggerType, currentHtml);

        logger.info("Heartbeat: calling Claude", { type: triggerType, reports: triggerReports.length });
        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicApiKey.value(),
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            messages: [{ role: "user", content: prompt }]
          })
        });

        if (!claudeRes.ok) throw new Error(`Claude API ${claudeRes.status}`);
        const claudeData   = await claudeRes.json();
        const fullResponse = claudeData.content[0].text;

        // ── 6. Parse patches and apply ───────────────────────────────────
        const diagMatch = fullResponse.match(/DIAGNOSIS:\s*([\s\S]*?)(?=\nPATCHES:)/i);
        const diagnosis = diagMatch ? diagMatch[1].trim() : "AutoPilot heartbeat fix.";

        if (!fullResponse.includes("<<<FIND>>>")) throw new Error("Claude did not return patches in the expected format.");

        const { patched: html, patchCount, errors: patchErrors } = applyPatches(currentHtml, fullResponse);
        logger.info("Heartbeat patches applied", { patchCount, patchErrors: patchErrors.length });

        await db.collection("config").doc("betaVersion").set({
          html, diagnosis, type: triggerType,
          reportCount: triggerReports.length,
          status: "published",   // published directly — fully autonomous, no admin approval needed
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          promotedAt: null,
          autoTriggered: true,
          triggeredBy: "heartbeat"
        });
        await db.collection("config").doc("analysisQueue").delete().catch(() => {});

        logger.info("Heartbeat: SUCCESS — beta published automatically", {
          type: triggerType, reportCount: triggerReports.length, htmlLength: html.length
        });
        return res.json({ ok: true, message: "Beta published automatically", type: triggerType, reportCount: triggerReports.length });

      } catch (err) {
        logger.error("Heartbeat error", { message: err.message, stack: err.stack });
        return res.status(500).json({ ok: false, error: err.message });
      }
    }


    // ── Debug: GET /counter?action=debugHeartbeat ────────────────────────────
    // Runs all heartbeat steps except Claude call — returns step-by-step trace
    if (req.method === "GET" && req.query.action === "debugHeartbeat") {
      const trace = [];
      try {
        const settingsDoc = await db.collection("config").doc("settings").get();
        const threshold         = settingsDoc.exists ? (settingsDoc.data().threshold         || 5) : 5;
        const heartbeatInterval = settingsDoc.exists ? (settingsDoc.data().heartbeatInterval || 5) : 5;
        const lastHeartbeatAt   = settingsDoc.exists ? settingsDoc.data().lastHeartbeatAt    : null;
        trace.push({ step: 1, threshold, heartbeatInterval, lastHeartbeatAt: lastHeartbeatAt?.toDate?.()?.toISOString() || null });

        let elapsedMin = null;
        if (lastHeartbeatAt) {
          elapsedMin = (Date.now() - lastHeartbeatAt.toDate().getTime()) / 60000;
          if (elapsedMin < heartbeatInterval) {
            trace.push({ step: 'EXIT', reason: 'interval not elapsed', elapsedMin });
            return res.json({ trace });
          }
        }
        trace.push({ step: '1-PASS', elapsedMin });

        const [betaDoc, queueDoc] = await Promise.all([
          db.collection("config").doc("betaVersion").get(),
          db.collection("config").doc("analysisQueue").get()
        ]);
        const betaStatus = betaDoc.exists ? betaDoc.data().status : null;
        trace.push({ step: 2, betaExists: betaDoc.exists, betaStatus, queueExists: queueDoc.exists });
        if (betaDoc.exists && (betaStatus === "pending_review" || betaStatus === "published")) {
          trace.push({ step: 'EXIT', reason: 'beta exists', betaStatus });
          return res.json({ trace });
        }
        trace.push({ step: '2-PASS' });

        const allPendingSnap = await db.collection("feedbackReports")
          .where("status", "==", "pending")
          .get();
        const bugs = [], features = [];
        allPendingSnap.forEach(doc => {
          if (doc.data().type === "bug") bugs.push(doc.data().text?.substring(0,50));
          else features.push(doc.data().text?.substring(0,50));
        });
        trace.push({ step: 3, bugs: bugs.length, features: features.length, threshold });

        let triggerType = null;
        if (bugs.length >= threshold)     triggerType = "bug";
        else if (features.length >= threshold) triggerType = "feature";
        trace.push({ step: '3-result', triggerType, wouldTrigger: !!triggerType });

        if (!triggerType) {
          trace.push({ step: 'EXIT', reason: 'threshold not reached' });
          return res.json({ trace });
        }
        trace.push({ step: '3-PASS', triggerType });

        // Step 4: fetch index.html
        const siteRes = await fetch("https://raw.githubusercontent.com/bruceinpb/oldtimeyai/main/public/index.html");
        trace.push({ step: 4, indexHtmlStatus: siteRes.status, ok: siteRes.ok });
        if (!siteRes.ok) {
          trace.push({ step: 'EXIT', reason: 'index.html fetch failed' });
          return res.json({ trace });
        }
        const html = await siteRes.text();
        trace.push({ step: '4-PASS', htmlLength: html.length });
        trace.push({ step: 'WOULD_CALL_CLAUDE', triggerType, reportsCount: triggerType === "bug" ? bugs.length : features.length });
        return res.json({ trace, status: "All steps pass — Claude would be called next" });
      } catch (err) {
        trace.push({ step: 'ERROR', message: err.message });
        return res.json({ trace, error: err.message });
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

