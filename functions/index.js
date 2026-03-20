// Deployed: 2026-03-19T12:55:00Z
const { onRequest } = require("firebase-functions/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");


// ── AutoPilot: shared prompt builder and patch applier ────────────────────────
function buildAutoPilotPrompt(reports, type, currentHtml) {
  const bugReports     = reports.filter(r => r.type === "bug");
  const featureReports = reports.filter(r => r.type === "feature");

  const reportsText = reports.map((r, i) =>
    `[${r.type.toUpperCase()}] Report ${i + 1} (${r.timestamp ? new Date(r.timestamp).toLocaleDateString() : "unknown"}): ${r.text}`
  ).join("\n");

  const summary = [
    bugReports.length     ? `${bugReports.length} bug report(s)`     : null,
    featureReports.length ? `${featureReports.length} feature request(s)` : null
  ].filter(Boolean).join(" and ");

  return `You are an expert web developer maintaining OldTimeyAI (oldtimeyai.com), a steampunk-themed historical AI chat website.

The AutoPilot system has collected ${summary} that need to be addressed.

ALL USER REPORTS:
${reportsText}

CURRENT HTML (${currentHtml.length} bytes) — this may already include previous AutoPilot patches:
${currentHtml}

YOUR TASK:
1. Read ALL reports carefully — address bugs AND features in a single pass
2. Group similar reports, diagnose root causes
3. Implement ALL fixes and features as patches to the HTML

RESPONSE FORMAT — you MUST use exactly this format:

DIAGNOSIS:
[3-6 sentences covering all bugs fixed and features added]

PATCHES:
[One or more patches — repeat as needed:]
<<<FIND>>>
[exact text from the current HTML to find — minimum 3 unique lines]
<<<REPLACE>>>
[replacement text]
<<<END>>>

RULES:
- Address EVERY report — bugs and features together in one response
- Each FIND block must be UNIQUE in the HTML — include enough context lines
- Do NOT return the full HTML file — only changed sections as patches
- Do NOT use markdown code fences
- Each patch replaces exactly the FIND text with the REPLACE text
- If adding something new, include the surrounding anchor lines in FIND
- The HTML you receive may already have previous patches applied — work with what is there
- GALLERY CARD IMAGES: Gallery cards use local paths /gallery/card1.png through /gallery/card5.png.
  NEVER use Unsplash URLs. NEVER invent any URL. NEVER change the src path of a gallery img tag.
  When a report requests a gallery image change, do TWO things only:
    1. Update the card-label text to match the requested subject
    2. Add a GENERATE_IMAGE marker comment on the same line immediately after the img closing tag:
       <!-- GENERATE_IMAGE:slot=N:detailed visual description for DALL-E -->
  where N is the card number (1-5). The server reads this marker, calls DALL-E 3 automatically,
  and commits the real image to /gallery/cardN.png. The img src always stays /gallery/cardN.png.
  EXAMPLE — user asks "change card 5 to a Victorian steam train":
    <img src="/gallery/card5.png" alt="Victorian Steam Train" onerror="this.onerror=null;this.src='https://picsum.photos/seed/fordt42/400/500'"><!-- GENERATE_IMAGE:slot=5:Victorian era steam locomotive at a station platform, coal smoke billowing, period passengers in top hats, sepia photograph style -->
    <div class="card-label">Victorian Steam Train</div>
- CRITICAL: NEVER modify the modal loop prevention logic. The following are protected:
  sessionStorage keys: 'beta_seen_at', '_stableLoad', 'using_beta'
  JS variables: _updateModalShown, _lastKnownBetaCreatedAt, _updateBetaData, _updateTimer
  These work as a cross-reload handshake. Any change to them causes infinite modal loops.`;
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


// ── AutoPilot: DALL-E Gallery Image Generation + Atomic GitHub Commit ────────
// Called by heartbeat, promoteBeta, and auto-promote whenever the patched HTML
// contains <!-- GENERATE_IMAGE:slot=N:description --> markers.
// Generates each requested image via DALL-E 3, then commits ALL images + HTML
// in a single atomic Git commit via the GitHub Trees API (one CI/CD run, no races).
//
// Returns { commitSha, imagesGenerated, cleanHtml }
//   commitSha      — the GitHub commit SHA, or null if no markers were found
//   imagesGenerated — number of images successfully generated
//   cleanHtml       — HTML with all GENERATE_IMAGE markers stripped out
//                    (always safe to save to Firestore regardless of whether images fired)
//
async function generateAndCommitGalleryImages(html, pat, openAiKey, commitMessage) {

  const DALLE_STYLE = "Vintage sepia-toned antique photograph, high contrast, aged paper texture, historically accurate, photorealistic: ";
  const GH_OWNER    = "bruceinpb";
  const GH_REPO     = "oldtimeyai";
  const GH_HEADERS  = {
    "Authorization": `token ${pat}`,
    "Content-Type":  "application/json",
    "User-Agent":    "OldTimeyAI-AutoPilot"
  };

  // ── Step 1: Extract GENERATE_IMAGE markers ────────────────────────────────
  // Regex uses [\s\S]+? (lazy) so hyphens inside descriptions work fine.
  // A naive [^-]+ would stop at the first hyphen in the description text.
  const MARKER_RE = /<!--\s*GENERATE_IMAGE:slot=(\d):([\s\S]+?)-->/g;
  const markers   = [];
  let   m;
  while ((m = MARKER_RE.exec(html)) !== null) {
    markers.push({ slot: parseInt(m[1], 10), desc: m[2].trim(), fullMatch: m[0] });
  }

  // Always strip markers so cleanHtml is safe to save / show to users
  let cleanHtml = html;
  for (const marker of markers) {
    cleanHtml = cleanHtml.replace(marker.fullMatch, "");
  }

  // If no markers or no OpenAI key, return immediately — caller handles the push
  if (markers.length === 0) {
    logger.info("generateAndCommitGalleryImages: no markers found — skipping image generation");
    return { commitSha: null, imagesGenerated: 0, cleanHtml };
  }
  if (!openAiKey) {
    logger.warn("generateAndCommitGalleryImages: markers found but no OpenAI key configured", {
      slots: markers.map(mk => mk.slot)
    });
    return { commitSha: null, imagesGenerated: 0, cleanHtml };
  }

  logger.info("generateAndCommitGalleryImages: starting", {
    count: markers.length, slots: markers.map(mk => mk.slot)
  });

  // ── Step 2: Call DALL-E 3 for each marker, create GitHub blob per image ───
  const imageTreeEntries = [];

  for (const marker of markers) {
    const prompt = DALLE_STYLE + marker.desc;
    logger.info(`DALL-E generating card ${marker.slot}`, { prompt: prompt.substring(0, 100) });

    const dalleRes = await fetch("https://api.openai.com/v1/images/generations", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${openAiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model:           "dall-e-3",
        prompt:          prompt,
        n:               1,
        size:            "1024x1024",
        response_format: "b64_json"     // permanent binary — no expiring Azure URLs
      })
    });
    if (!dalleRes.ok) {
      const errBody = await dalleRes.text();
      throw new Error(`DALL-E error for slot ${marker.slot}: HTTP ${dalleRes.status} — ${errBody.substring(0, 200)}`);
    }
    const dalleData = await dalleRes.json();
    if (!dalleData.data || !dalleData.data[0] || !dalleData.data[0].b64_json) {
      throw new Error(`DALL-E returned unexpected structure for slot ${marker.slot}`);
    }
    const imgB64 = dalleData.data[0].b64_json;
    logger.info(`DALL-E image received for card ${marker.slot}`, { b64Chars: imgB64.length });

    // Upload image to GitHub as a blob
    const blobRes = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/blobs`,
      { method: "POST", headers: GH_HEADERS, body: JSON.stringify({ content: imgB64, encoding: "base64" }) }
    );
    if (!blobRes.ok) {
      throw new Error(`GitHub blob creation failed for slot ${marker.slot}: HTTP ${blobRes.status}`);
    }
    const blobData = await blobRes.json();
    if (!blobData.sha) {
      throw new Error(`GitHub blob returned no SHA for slot ${marker.slot}: ${JSON.stringify(blobData).substring(0, 200)}`);
    }
    logger.info(`GitHub blob created for card ${marker.slot}`, { sha: blobData.sha });
    imageTreeEntries.push({
      path: `public/gallery/card${marker.slot}.png`,
      mode: "100644",
      type: "blob",
      sha:  blobData.sha
    });
  }

  // ── Step 3: Create GitHub blob for the cleaned index.html ─────────────────
  const htmlB64     = Buffer.from(cleanHtml).toString("base64");
  const htmlBlobRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/blobs`,
    { method: "POST", headers: GH_HEADERS, body: JSON.stringify({ content: htmlB64, encoding: "base64" }) }
  );
  if (!htmlBlobRes.ok) {
    throw new Error(`GitHub HTML blob creation failed: HTTP ${htmlBlobRes.status}`);
  }
  const htmlBlobData = await htmlBlobRes.json();
  if (!htmlBlobData.sha) {
    throw new Error(`GitHub HTML blob returned no SHA: ${JSON.stringify(htmlBlobData).substring(0, 200)}`);
  }

  // ── Step 4: Get current HEAD commit and tree ───────────────────────────────
  const refsRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/refs/heads/main`,
    { headers: GH_HEADERS }
  );
  if (!refsRes.ok) {
    throw new Error(`GitHub refs fetch failed: HTTP ${refsRes.status}`);
  }
  const refsData = await refsRes.json();
  if (!refsData.object || !refsData.object.sha) {
    throw new Error(`GitHub refs returned unexpected structure: ${JSON.stringify(refsData).substring(0, 200)}`);
  }
  const headSha = refsData.object.sha;

  const commitFetchRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/commits/${headSha}`,
    { headers: GH_HEADERS }
  );
  if (!commitFetchRes.ok) {
    throw new Error(`GitHub commit fetch failed: HTTP ${commitFetchRes.status}`);
  }
  const commitFetchData = await commitFetchRes.json();
  if (!commitFetchData.tree || !commitFetchData.tree.sha) {
    throw new Error(`GitHub commit returned no tree SHA: ${JSON.stringify(commitFetchData).substring(0, 200)}`);
  }
  const currentTreeSha = commitFetchData.tree.sha;

  // ── Step 5: Create new Git tree (all images + index.html together) ─────────
  const allTreeEntries = [
    { path: "public/index.html", mode: "100644", type: "blob", sha: htmlBlobData.sha },
    ...imageTreeEntries
  ];
  const newTreeRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/trees`,
    { method: "POST", headers: GH_HEADERS, body: JSON.stringify({ base_tree: currentTreeSha, tree: allTreeEntries }) }
  );
  if (!newTreeRes.ok) {
    throw new Error(`GitHub tree creation failed: HTTP ${newTreeRes.status}`);
  }
  const newTreeData = await newTreeRes.json();
  if (!newTreeData.sha) {
    throw new Error(`GitHub tree returned no SHA: ${JSON.stringify(newTreeData).substring(0, 200)}`);
  }
  const newTreeSha = newTreeData.sha;

  // ── Step 6: Create the commit ───────────────────────────────────────────────
  const newCommitRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/commits`,
    {
      method:  "POST",
      headers: GH_HEADERS,
      body: JSON.stringify({
        message: commitMessage || `autopilot: gallery image(s) + index.html (${markers.length} image(s))`,
        tree:    newTreeSha,
        parents: [headSha]
      })
    }
  );
  if (!newCommitRes.ok) {
    throw new Error(`GitHub commit creation failed: HTTP ${newCommitRes.status}`);
  }
  const newCommitData = await newCommitRes.json();
  if (!newCommitData.sha) {
    throw new Error(`GitHub commit returned no SHA: ${JSON.stringify(newCommitData).substring(0, 200)}`);
  }
  const newCommitSha = newCommitData.sha;

  // ── Step 7: Advance HEAD ref to the new commit ────────────────────────────
  const refUpdateRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/refs/heads/main`,
    { method: "PATCH", headers: GH_HEADERS, body: JSON.stringify({ sha: newCommitSha }) }
  );
  if (!refUpdateRes.ok) {
    throw new Error(`GitHub ref update failed: HTTP ${refUpdateRes.status}`);
  }

  logger.info("generateAndCommitGalleryImages: SUCCESS", {
    commitSha: newCommitSha,
    imagesGenerated: markers.length,
    paths: imageTreeEntries.map(e => e.path)
  });

  return { commitSha: newCommitSha, imagesGenerated: markers.length, cleanHtml };
}


// ── Internal helper: push index.html only via Git Trees API ──────────────────
// Used when there are no GENERATE_IMAGE markers but we still need to push HTML.
// Returns the new commit SHA.
async function pushHtmlOnly(html, pat, commitMessage) {
  const GH_OWNER   = "bruceinpb";
  const GH_REPO    = "oldtimeyai";
  const GH_HEADERS = {
    "Authorization": `token ${pat}`,
    "Content-Type":  "application/json",
    "User-Agent":    "OldTimeyAI-AutoPilot"
  };

  // Create blob
  const htmlB64     = Buffer.from(html).toString("base64");
  const blobRes     = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/blobs`,
    { method: "POST", headers: GH_HEADERS, body: JSON.stringify({ content: htmlB64, encoding: "base64" }) }
  );
  if (!blobRes.ok) throw new Error(`pushHtmlOnly: blob failed HTTP ${blobRes.status}`);
  const blobSha = (await blobRes.json()).sha;
  if (!blobSha) throw new Error("pushHtmlOnly: blob returned no SHA");

  // Get HEAD + tree
  const refsData    = await (await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/refs/heads/main`, { headers: GH_HEADERS })).json();
  const headSha     = refsData?.object?.sha;
  if (!headSha) throw new Error("pushHtmlOnly: could not get HEAD SHA");

  const commitData  = await (await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/commits/${headSha}`, { headers: GH_HEADERS })).json();
  const treeSha     = commitData?.tree?.sha;
  if (!treeSha) throw new Error("pushHtmlOnly: could not get tree SHA");

  // New tree
  const newTreeRes  = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/trees`, { method: "POST", headers: GH_HEADERS, body: JSON.stringify({ base_tree: treeSha, tree: [{ path: "public/index.html", mode: "100644", type: "blob", sha: blobSha }] }) });
  if (!newTreeRes.ok) throw new Error(`pushHtmlOnly: tree failed HTTP ${newTreeRes.status}`);
  const newTreeSha  = (await newTreeRes.json()).sha;
  if (!newTreeSha) throw new Error("pushHtmlOnly: new tree returned no SHA");

  // Commit
  const newCommitRes = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/commits`, { method: "POST", headers: GH_HEADERS, body: JSON.stringify({ message: commitMessage, tree: newTreeSha, parents: [headSha] }) });
  if (!newCommitRes.ok) throw new Error(`pushHtmlOnly: commit failed HTTP ${newCommitRes.status}`);
  const newCommitSha = (await newCommitRes.json()).sha;
  if (!newCommitSha) throw new Error("pushHtmlOnly: new commit returned no SHA");

  // Advance HEAD
  const refRes = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/git/refs/heads/main`, { method: "PATCH", headers: GH_HEADERS, body: JSON.stringify({ sha: newCommitSha }) });
  if (!refRes.ok) throw new Error(`pushHtmlOnly: ref update failed HTTP ${refRes.status}`);

  logger.info("pushHtmlOnly: SUCCESS", { commitSha: newCommitSha });
  return newCommitSha;
}
exports.counter = onRequest(
  { 
    cors: true,
    invoker: "public",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [anthropicApiKey]
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

            // Don't re-queue if beta is actively being reviewed or already queued for analysis.
            // A "published" beta is fine — new reports should still be counted and will layer
            // on top of the existing beta on the next heartbeat cycle.
            const betaDoc = await db.collection("config").doc("betaVersion").get();
            if (betaDoc.exists) {
              const s = betaDoc.data().status;
              if (s === "pending_review" || s === "queued") return;
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
        const validStatuses = ["pending", "reviewed", "dismissed", "deployed"];
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
        // Also fetch client modal settings so poller can pass them to the countdown modal
        const settingsSnap = await db.collection("config").doc("settings").get();
        const clientModalSeconds     = settingsSnap.exists ? (settingsSnap.data().clientModalSeconds     || 30) : 30;
        const bugReportWindowMinutes = settingsSnap.exists ? (settingsSnap.data().bugReportWindowMinutes || 5)  : 5;

        // ── Self-healing: if Cloud Scheduler has gone silent, re-trigger heartbeat ──
        // getBeta is called by the client poller every 60s, so this fires regularly.
        // If lastHeartbeatAt is older than 2× the configured interval, kick it off.
        const lastHeartbeatAt   = settingsSnap.exists ? settingsSnap.data().lastHeartbeatAt : null;
        const heartbeatInterval = settingsSnap.exists ? (settingsSnap.data().heartbeatInterval || 5) : 5;
        const staleCutoffMs     = heartbeatInterval * 2 * 60 * 1000;
        const heartbeatAgeMs    = lastHeartbeatAt ? (Date.now() - lastHeartbeatAt.toDate().getTime()) : Infinity;
        if (heartbeatAgeMs > staleCutoffMs) {
          logger.warn("getBeta: heartbeat appears stale — self-healing trigger", {
            ageMinutes: Math.round(heartbeatAgeMs / 60000),
            thresholdMinutes: heartbeatInterval * 2
          });
          // Fire-and-forget: don't await, don't block the response
          fetch(`https://us-central1-${process.env.GCLOUD_PROJECT || "oldtimeyai-928be"}.cloudfunctions.net/counter?action=heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" }
          }).catch(e => logger.error("Self-heal heartbeat trigger failed", { message: e.message }));
        }

        return res.json({
          exists: true,
          html: d.html,
          diagnosis: d.diagnosis,
          type: d.type,
          reportCount: d.reportCount,
          bugCount: d.bugCount || null,
          featureCount: d.featureCount || null,
          patchLayers: d.patchLayers || null,
          betaChain: d.betaChain || [],
          autoTriggered: d.autoTriggered || false,
          clientModalSeconds,
          bugReportWindowMinutes,
          createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
          updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
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
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
    // Promotes beta to stable: pushes beta HTML (and any pending DALL-E gallery images)
    // to GitHub via the Git Trees API, triggering the CI/CD deploy pipeline.
    if (req.method === "POST" && req.query.action === "promoteBeta") {
      try {
        const betaDoc = await db.collection("config").doc("betaVersion").get();
        if (!betaDoc.exists) return res.status(404).json({ error: "No beta version exists." });
        const betaData = betaDoc.data();
        const betaHtml = betaData.html;
        if (!betaHtml || betaHtml.length < 100) {
          return res.status(400).json({ error: "Beta HTML is empty or invalid." });
        }

        // Read PAT and optional OpenAI key from Firestore secrets
        const secretsDoc = await db.collection("config").doc("secrets").get();
        const pat        = secretsDoc.exists ? secretsDoc.data().githubPat : null;
        const openAiKey  = secretsDoc.exists ? secretsDoc.data().openAiKey  : null;
        if (!pat) return res.status(500).json({ error: "GitHub PAT not configured. Add it via the admin panel Settings tab." });

        const commitMsg = `promote: AutoPilot beta → stable (${betaData.type}, ${betaData.reportCount} reports)`;

        // generateAndCommitGalleryImages handles BOTH cases:
        //   - If GENERATE_IMAGE markers exist: generates images + commits images+HTML atomically
        //   - If no markers: returns commitSha=null, cleanHtml=betaHtml (markers stripped, noop)
        const { commitSha: imgCommitSha, imagesGenerated, cleanHtml } =
          await generateAndCommitGalleryImages(betaHtml, pat, openAiKey, commitMsg);

        // If no markers were found, we still need to push the HTML to GitHub
        const finalCommitSha = imgCommitSha
          ? imgCommitSha
          : await pushHtmlOnly(cleanHtml, pat, commitMsg);

        // Record promotion in Firestore
        await db.collection("config").doc("stableVersion").set({
          html:          cleanHtml,
          promotedFrom:  "beta",
          commitSha:     finalCommitSha,
          promotedAt:    admin.firestore.FieldValue.serverTimestamp(),
          type:          betaData.type,
          reportCount:   betaData.reportCount,
          diagnosis:     betaData.diagnosis || ""
        });
        await db.collection("config").doc("betaVersion").update({
          status:     "promoted",
          promotedAt: admin.firestore.FieldValue.serverTimestamp(),
          commitSha:  finalCommitSha
        });

        logger.info("Beta promoted to stable via GitHub", { commitSha: finalCommitSha, imagesGenerated });
        return res.json({ ok: true, commitSha: finalCommitSha, imagesGenerated, message: "Beta pushed to GitHub — CI/CD deploying now." });

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

    // ── PAT: POST /counter?action=saveGithubPat ──────────────────────────────
    // Stores the GitHub PAT in Firestore config/secrets (server-side only).
    // Never exposed to clients — Firestore rules block public reads of config/.
    if (req.method === "POST" && req.query.action === "saveGithubPat") {
      try {
        const { pat } = req.body || {};
        if (!pat || typeof pat !== "string" || !pat.startsWith("github_")) {
          return res.status(400).json({ error: "Invalid PAT — must start with 'github_'." });
        }
        await db.collection("config").doc("secrets").set(
          { githubPat: pat, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        logger.info("GitHub PAT saved to Firestore config/secrets");
        return res.json({ ok: true, message: "PAT saved. Promote to Stable is now enabled." });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── PAT: GET /counter?action=checkGithubPat ──────────────────────────────
    // Returns whether a PAT is configured (never returns the actual value).
    if (req.method === "GET" && req.query.action === "checkGithubPat") {
      try {
        const doc = await db.collection("config").doc("secrets").get();
        const configured = doc.exists && !!doc.data().githubPat;
        const updatedAt = doc.exists ? doc.data().updatedAt?.toDate?.()?.toISOString() || null : null;
        return res.json({ configured, updatedAt });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── OpenAI: POST /counter?action=saveOpenAiKey ────────────────────────────
    // Stores the OpenAI API key in Firestore config/secrets (server-side only).
    // Never exposed to clients. Used by AutoPilot for DALL-E 3 gallery generation.
    if (req.method === "POST" && req.query.action === "saveOpenAiKey") {
      try {
        const { key } = req.body || {};
        if (!key || typeof key !== "string" || !key.startsWith("sk-")) {
          return res.status(400).json({ error: "Invalid OpenAI key — must start with 'sk-'." });
        }
        await db.collection("config").doc("secrets").set(
          { openAiKey: key, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        logger.info("OpenAI API key saved to Firestore config/secrets");
        return res.json({ ok: true, message: "OpenAI key saved. DALL-E gallery generation is now enabled." });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── OpenAI: GET /counter?action=checkOpenAiKey ────────────────────────────
    // Returns whether an OpenAI key is configured (never returns the actual value).
    if (req.method === "GET" && req.query.action === "checkOpenAiKey") {
      try {
        const doc = await db.collection("config").doc("secrets").get();
        const configured = doc.exists && !!doc.data().openAiKey;
        return res.json({ configured });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Bug Review: POST /counter?action=flagBugReport ──────────────────────────
    // Called when a user reports a bug during the auto-update window.
    // Saves a critical feedback report and creates a 12-hour admin review queue entry.
    if (req.method === "POST" && req.query.action === "flagBugReport") {
      try {
        const { text, betaCreatedAt, clientModalSeconds, bugReportWindowMinutes } = req.body || {};
        if (!text || typeof text !== "string" || text.trim().length < 3) {
          return res.status(400).json({ error: "Bug report text is required." });
        }

        const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();

        // Save as a critical feedback report
        const reportRef = await db.collection("feedbackReports").add({
          text: text.trim().substring(0, 2000),
          type: "bug",
          criticalFlag: true,          // flagged as critical — came through update modal
          betaCreatedAt: betaCreatedAt || null,
          clientModalSeconds: clientModalSeconds || 30,
          bugReportWindowMinutes: bugReportWindowMinutes || 5,
          ip,
          userAgent: req.headers["user-agent"] || null,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "pending"
        });

        // Get current beta for review queue
        const betaDoc = await db.collection("config").doc("betaVersion").get();

        // Write/update bug review queue — 12h review window
        const reviewDeadline = new Date(Date.now() + 12 * 60 * 60 * 1000);
        const existingQueue = await db.collection("config").doc("bugReviewQueue").get();
        if (existingQueue.exists && existingQueue.data().status === "pending_review") {
          // Add to existing queue
          const existing = existingQueue.data().reportIds || [];
          await db.collection("config").doc("bugReviewQueue").update({
            reportIds: [...existing, reportRef.id],
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          // Create new review queue entry
          await db.collection("config").doc("bugReviewQueue").set({
            reportIds: [reportRef.id],
            betaCreatedAt: betaCreatedAt || null,
            betaPatchLayers: betaDoc.exists ? (betaDoc.data().patchLayers || 1) : null,
            flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewDeadline: admin.firestore.Timestamp.fromDate(reviewDeadline),
            status: "pending_review",   // pending_review | approved | rolled_back
            clientModalSeconds: clientModalSeconds || 30,
            bugReportWindowMinutes: bugReportWindowMinutes || 5
          });
        }

        logger.info("Critical bug report flagged", { reportId: reportRef.id, ip });
        return res.json({ ok: true, reviewDeadline: reviewDeadline.toISOString() });
      } catch (error) {
        logger.error("flagBugReport error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Bug Review: GET /counter?action=getBugReviewQueue ────────────────────
    if (req.method === "GET" && req.query.action === "getBugReviewQueue") {
      try {
        const doc = await db.collection("config").doc("bugReviewQueue").get();
        if (!doc.exists) return res.json({ exists: false });
        const d = doc.data();
        return res.json({
          exists: true,
          reportIds: d.reportIds || [],
          betaCreatedAt: d.betaCreatedAt || null,
          betaPatchLayers: d.betaPatchLayers || null,
          flaggedAt: d.flaggedAt?.toDate?.()?.toISOString() || null,
          reviewDeadline: d.reviewDeadline?.toDate?.()?.toISOString() || null,
          status: d.status,
          clientModalSeconds: d.clientModalSeconds || 30,
          bugReportWindowMinutes: d.bugReportWindowMinutes || 5
        });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Bug Review: POST /counter?action=resolveBugReview ────────────────────
    // Admin resolves the review: approve (keep beta) or rollback (revert to previous stable)
    if (req.method === "POST" && req.query.action === "resolveBugReview") {
      try {
        const { action } = req.body || {};  // "approve" | "rollback"
        if (!["approve", "rollback"].includes(action)) {
          return res.status(400).json({ error: "action must be 'approve' or 'rollback'" });
        }

        if (action === "rollback") {
          // Push previous stable HTML back to GitHub
          const secretsDoc = await db.collection("config").doc("secrets").get();
          const pat = secretsDoc.exists ? secretsDoc.data().githubPat : null;
          if (!pat) return res.status(500).json({ error: "GitHub PAT not configured." });

          const stableDoc = await db.collection("config").doc("stableVersion").get();
          if (!stableDoc.exists) return res.status(404).json({ error: "No previous stable version found." });
          const stableHtml = stableDoc.data().html;
          if (!stableHtml || stableHtml.length < 10000) {
            return res.status(400).json({ error: "Previous stable HTML is invalid." });
          }

          const shaRes = await fetch(
            "https://api.github.com/repos/bruceinpb/oldtimeyai/contents/public/index.html",
            { headers: { "Authorization": `token ${pat}`, "User-Agent": "OldTimeyAI-AutoPilot" } }
          );
          if (!shaRes.ok) throw new Error(`GitHub SHA fetch failed: ${shaRes.status}`);
          const shaData = await shaRes.json();

          const pushRes = await fetch(
            "https://api.github.com/repos/bruceinpb/oldtimeyai/contents/public/index.html",
            {
              method: "PUT",
              headers: { "Authorization": `token ${pat}`, "Content-Type": "application/json", "User-Agent": "OldTimeyAI-AutoPilot" },
              body: JSON.stringify({
                message: "rollback: Admin rolled back due to critical bug report",
                content: Buffer.from(stableHtml).toString("base64"),
                sha: shaData.sha
              })
            }
          );
          if (!pushRes.ok) throw new Error(`GitHub push failed: ${pushRes.status}`);

          // Clear beta and review queue
          await db.collection("config").doc("betaVersion").delete().catch(() => {});
          await db.collection("config").doc("bugReviewQueue").update({
            status: "rolled_back",
            resolvedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          logger.info("Rollback pushed to GitHub by admin");
          return res.json({ ok: true, action: "rollback", message: "Previous stable version pushed to GitHub." });
        }

        // approve — just close the review queue, beta will auto-promote normally
        await db.collection("config").doc("bugReviewQueue").update({
          status: "approved",
          resolvedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        logger.info("Bug review approved by admin");
        return res.json({ ok: true, action: "approve" });

      } catch (error) {
        logger.error("resolveBugReview error", { message: error.message });
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Settings: GET /counter?action=getSettings ─────────────────────────────
    if (req.method === "GET" && req.query.action === "getSettings") {
      try {
        const doc = await db.collection("config").doc("settings").get();
        const threshold                = doc.exists ? (doc.data().threshold                || 5)    : 5;
        const heartbeatInterval        = doc.exists ? (doc.data().heartbeatInterval        || 5)    : 5;
        const rateLimit                = doc.exists ? (doc.data().rateLimit                || 3)    : 3;
        const autoPromoteMinutes       = doc.exists ? (doc.data().autoPromoteMinutes       || 1440) : 1440;
        const clientModalSeconds       = doc.exists ? (doc.data().clientModalSeconds       || 30)   : 30;
        const bugReportWindowMinutes   = doc.exists ? (doc.data().bugReportWindowMinutes   || 5)    : 5;
        const lastHeartbeatAt          = doc.exists ? (doc.data().lastHeartbeatAt?.toDate?.()?.toISOString() || null) : null;
        return res.json({ threshold, heartbeatInterval, rateLimit, autoPromoteMinutes, clientModalSeconds, bugReportWindowMinutes, lastHeartbeatAt });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // ── Settings: POST /counter?action=saveSettings ───────────────────────────
    if (req.method === "POST" && req.query.action === "saveSettings") {
      try {
        const { threshold, heartbeatInterval, rateLimit, autoPromoteMinutes, clientModalSeconds, bugReportWindowMinutes, resetHeartbeat } = req.body || {};
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
        if (autoPromoteMinutes !== undefined) {
          const val = parseInt(autoPromoteMinutes);
          if (isNaN(val) || val < 5 || val > 43200) return res.status(400).json({ error: "Auto-promote must be 5–43200 minutes." });
          updates.autoPromoteMinutes = val;
        }
        if (clientModalSeconds !== undefined) {
          const val = parseInt(clientModalSeconds);
          if (isNaN(val) || val < 5 || val > 300) return res.status(400).json({ error: "Client modal countdown must be 5–300 seconds." });
          updates.clientModalSeconds = val;
        }
        if (bugReportWindowMinutes !== undefined) {
          const val = parseInt(bugReportWindowMinutes);
          if (isNaN(val) || val < 1 || val > 60) return res.status(400).json({ error: "Bug report window must be 1–60 minutes." });
          updates.bugReportWindowMinutes = val;
        }
        if (resetHeartbeat === true) {
          // Write epoch-0 so the next scheduler tick runs immediately (not delayed)
          updates.lastHeartbeatAt = new admin.firestore.Timestamp(0, 0);
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
    // Collects ALL pending bugs+features, applies patches on top of current beta
    // (or stable), marks all reports reviewed, and auto-promotes after threshold.
    if (req.method === "POST" && req.query.action === "heartbeat") {
      logger.info("AutoPilot heartbeat firing");
      try {
        // ── 1. Read settings ────────────────────────────────────────────
        // Cloud Scheduler (*/5 * * * *) is the rate limiter — no internal check needed.
        // We write lastHeartbeatAt immediately to prevent concurrent Cloud Run invocations
        // in the rare case two scheduler fires overlap.
        const settingsDoc = await db.collection("config").doc("settings").get();
        const threshold          = settingsDoc.exists ? (settingsDoc.data().threshold          || 1)    : 1;
        const heartbeatInterval  = settingsDoc.exists ? (settingsDoc.data().heartbeatInterval  || 5)    : 5;
        const autoPromoteMinutes = settingsDoc.exists ? (settingsDoc.data().autoPromoteMinutes || 1440) : 1440;
        const lastHeartbeatAt    = settingsDoc.exists ? settingsDoc.data().lastHeartbeatAt     : null;

        // Concurrency guard: if another invocation wrote lastHeartbeatAt in the last 60s, skip.
        // This is tighter than the scheduler interval to only block true duplicates.
        if (lastHeartbeatAt) {
          const elapsedMs = Date.now() - lastHeartbeatAt.toDate().getTime();
          if (elapsedMs < 60 * 1000) {
            logger.info("Heartbeat: skipping — duplicate invocation within 60s");
            return res.json({ ok: true, message: "Skipped — duplicate invocation" });
          }
        }

        // Claim this run
        await db.collection("config").doc("settings").set(
          { lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );

        // ── 2. Check auto-promote: if beta is older than autoPromoteMinutes, push to GitHub ──
        const betaDoc = await db.collection("config").doc("betaVersion").get();
        if (betaDoc.exists && (betaDoc.data().status === "published" || betaDoc.data().status === "pending_review")) {
          const betaCreatedAt = betaDoc.data().createdAt?.toDate?.();
          if (betaCreatedAt) {
            const betaAgeMs    = Date.now() - betaCreatedAt.getTime();
            const autoPromoteMs = autoPromoteMinutes * 60 * 1000;
            if (betaAgeMs >= autoPromoteMs) {
              logger.info("Heartbeat: auto-promoting beta to stable", { ageMinutes: Math.round(betaAgeMs / 60000) });
              try {
                const secretsDoc  = await db.collection("config").doc("secrets").get();
                const pat         = secretsDoc.exists ? secretsDoc.data().githubPat  : null;
                const openAiKey   = secretsDoc.exists ? secretsDoc.data().openAiKey  : null;

                if (pat) {
                  const betaHtml = betaDoc.data().html;
                  if (!betaHtml || betaHtml.length < 10000) {
                    logger.error("Heartbeat: auto-promote aborted — HTML too small", { length: betaHtml?.length });
                    await db.collection("config").doc("betaVersion").delete();
                    return res.json({ ok: true, message: "Auto-promote aborted: beta HTML invalid, cleared." });
                  }

                  const commitMsg = `auto-promote: AutoPilot beta → stable (${autoPromoteMinutes}min auto-promote)`;
                  const { commitSha: imgCommitSha, cleanHtml } =
                    await generateAndCommitGalleryImages(betaHtml, pat, openAiKey, commitMsg);

                  const finalCommitSha = imgCommitSha
                    ? imgCommitSha
                    : await pushHtmlOnly(cleanHtml, pat, commitMsg);

                  if (finalCommitSha) {
                    await db.collection("config").doc("betaVersion").update({
                      status:      "promoted",
                      promotedAt:  admin.firestore.FieldValue.serverTimestamp(),
                      autoPromoted: true,
                      commitSha:   finalCommitSha
                    });
                    logger.info("Heartbeat: auto-promote SUCCESS", { commitSha: finalCommitSha });
                  }
                }
              } catch (promoteErr) {
                logger.error("Heartbeat auto-promote failed", { message: promoteErr.message });
              }
              // Continue to check for new reports even after promoting
            }
          }
        }

        // ── 2b. Check bug review queue — if 12h passed with no admin action → auto-promote ──
        const bugReviewDoc = await db.collection("config").doc("bugReviewQueue").get();
        if (bugReviewDoc.exists && bugReviewDoc.data().status === "pending_review") {
          const reviewDeadline = bugReviewDoc.data().reviewDeadline?.toDate?.();
          if (reviewDeadline && Date.now() >= reviewDeadline.getTime()) {
            logger.info("Heartbeat: bug review 12h window expired — auto-approving");
            await db.collection("config").doc("bugReviewQueue").update({
              status: "approved",
              resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
              autoApproved: true
            });
            // Also trigger auto-promote of the current beta if it hasn't been promoted yet
            const currentBeta = await db.collection("config").doc("betaVersion").get();
            if (currentBeta.exists && currentBeta.data().status === "published") {
              logger.info("Heartbeat: triggering auto-promote after review expiry");
              // Force the createdAt to be old enough to trigger normal auto-promote on next check
              await db.collection("config").doc("betaVersion").update({
                createdAt: admin.firestore.Timestamp.fromDate(new Date(0))
              });
            }
          }
        }

        // ── 3. Collect ALL pending reports (bugs + features together) ───
        const allPendingSnap = await db.collection("feedbackReports")
          .where("status", "==", "pending")
          .get();

        const allReports = [];
        allPendingSnap.forEach(doc => {
          const d = doc.data();
          allReports.push({ id: doc.id, text: d.text, type: d.type,
            timestamp: d.timestamp?.toDate?.()?.toISOString() || null });
        });

        const bugCount     = allReports.filter(r => r.type === "bug").length;
        const featureCount = allReports.filter(r => r.type === "feature").length;
        logger.info("Heartbeat counts", { bugs: bugCount, features: featureCount, threshold });

        // Trigger if EITHER type meets threshold
        const shouldTrigger = bugCount >= threshold || featureCount >= threshold;
        if (!shouldTrigger) {
          logger.info("Heartbeat: threshold not yet reached");
          return res.json({ ok: true, message: "Threshold not yet reached", bugs: bugCount, features: featureCount, threshold });
        }

        // ── 4. Fetch base HTML — use current beta if it exists, else stable ──
        let baseHtml;
        const freshBetaDoc = await db.collection("config").doc("betaVersion").get();
        if (freshBetaDoc.exists && freshBetaDoc.data().html && freshBetaDoc.data().status !== "promoted") {
          baseHtml = freshBetaDoc.data().html;
          logger.info("Heartbeat: using current beta as base HTML", { length: baseHtml.length });
        } else {
          const siteRes = await fetch("https://raw.githubusercontent.com/bruceinpb/oldtimeyai/main/public/index.html");
          if (!siteRes.ok) throw new Error(`Could not fetch index.html: ${siteRes.status}`);
          baseHtml = await siteRes.text();
          logger.info("Heartbeat: using stable GitHub HTML as base", { length: baseHtml.length });
        }

        // ── 5. Call Claude with ALL reports ─────────────────────────────
        const prompt = buildAutoPilotPrompt(allReports, "mixed", baseHtml);
        logger.info("Heartbeat: calling Claude", { totalReports: allReports.length, bugs: bugCount, features: featureCount });

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

        // ── 6. Apply patches on top of base HTML ────────────────────────
        const diagMatch = fullResponse.match(/DIAGNOSIS:\s*([\s\S]*?)(?=\nPATCHES:)/i);
        const diagnosis = diagMatch ? diagMatch[1].trim() : "AutoPilot fix.";

        if (!fullResponse.includes("<<<FIND>>>")) throw new Error("Claude did not return patches in the expected format.");

        const { patched: html, patchCount, errors: patchErrors } = applyPatches(baseHtml, fullResponse);
        logger.info("Heartbeat patches applied", { patchCount, patchErrors: patchErrors.length });

        // ── Patch safety gate ────────────────────────────────────────────
        // If EVERY patch failed to match, the HTML is unchanged and saving it would
        // silently consume reports without actually fixing anything — causing an
        // endless loop where the same bug is "addressed" every cycle but never fixed.
        // Throw here so reports stay pending and the next heartbeat retries from scratch.
        if (patchCount === 0) {
          const errSummary = patchErrors.slice(0, 3).join(" | ");
          throw new Error(`All ${patchErrors.length} patch(es) failed to match — HTML unchanged. Not saving. Errors: ${errSummary}`);
        }
        if (patchErrors.length > 0) {
          logger.warn("Heartbeat: some patches failed to match", { patchCount, failedCount: patchErrors.length, errors: patchErrors });
        }

        // ── 7. Generate gallery images + commit HTML to GitHub ───────────────
        // Scan patched HTML for GENERATE_IMAGE markers. If found, call DALL-E 3 for each
        // and commit all images + HTML atomically via Git Trees API. Either way, get
        // cleanHtml (markers stripped) which is what we save everywhere.
        const secretsDocImg = await db.collection("config").doc("secrets").get();
        const patImg         = secretsDocImg.exists ? secretsDocImg.data().githubPat  : null;
        const openAiKeyImg   = secretsDocImg.exists ? secretsDocImg.data().openAiKey  : null;

        const diagMsg = `autopilot: ${diagnosis.substring(0, 80)} (${allReports.length} report(s))`;
        const { commitSha: imgCommitSha, imagesGenerated, cleanHtml } =
          await generateAndCommitGalleryImages(html, patImg, openAiKeyImg, diagMsg);

        // If there were no GENERATE_IMAGE markers, generateAndCommitGalleryImages returned
        // commitSha=null — we do NOT push here; the auto-promote path will push when beta matures.
        // (We never push on every heartbeat cycle — only on promote.)
        if (imgCommitSha) {
          logger.info("Heartbeat: gallery images committed alongside HTML", {
            imagesGenerated, commitSha: imgCommitSha
          });
        }

        // ── 8. Build chain history ────────────────────────────────────────────
        const existingChain = (freshBetaDoc.exists && freshBetaDoc.data().betaChain) ? freshBetaDoc.data().betaChain : [];
        const newChainEntry = {
          diagnosis,
          bugCount,
          featureCount,
          reportCount: allReports.length,
          appliedAt:   new Date().toISOString()
        };
        const betaChain = [...existingChain, newChainEntry];

        // ── 9. Save beta to Firestore — always use cleanHtml (markers stripped) ──
        await db.collection("config").doc("betaVersion").set({
          html:         cleanHtml,   // markers stripped; img src still points to /gallery/cardN.png
          diagnosis,
          betaChain,
          type:         "mixed",
          bugCount,
          featureCount,
          reportCount:  allReports.length,
          status:       "published",
          createdAt:    admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
          promotedAt:   null,
          autoTriggered: true,
          triggeredBy:  "heartbeat",
          patchLayers:  betaChain.length,
          ...(imgCommitSha ? { galleryCommitSha: imgCommitSha } : {})
        });

        // ── 10. Mark ALL pending reports reviewed ─────────────────────────────
        const batch = db.batch();
        allPendingSnap.forEach(doc => batch.update(doc.ref, { status: "reviewed" }));
        await batch.commit();
        logger.info("Heartbeat: marked all pending reports reviewed", { count: allReports.length });

        logger.info("Heartbeat: SUCCESS", { totalReports: allReports.length, patchLayers: betaChain.length, patchCount });
        return res.json({
          ok: true,
          message: `Beta updated (layer ${betaChain.length}) — ${allReports.length} reports addressed`,
          bugs: bugCount,
          features: featureCount,
          patchLayers: betaChain.length,
          patchCount
        });

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

        // Concurrency guard (mirrors real heartbeat — only blocks within 60s)
        let elapsedSec = null;
        if (lastHeartbeatAt) {
          elapsedSec = (Date.now() - lastHeartbeatAt.toDate().getTime()) / 1000;
          if (elapsedSec < 60) {
            trace.push({ step: 'EXIT', reason: 'duplicate invocation within 60s', elapsedSec });
            return res.json({ trace });
          }
        }
        trace.push({ step: '1-PASS', elapsedSec, note: 'concurrency guard passed (>60s)' });

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

