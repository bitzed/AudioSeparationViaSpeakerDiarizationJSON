"use strict";
/**
 * AudioSeparator — PoC web server.
 *
 * Flow:
 *   1. POST /api/transcribe  { url }
 *        -> calls Zoom Scribe (sync, diarization) and returns the transcript
 *           plus a per-speaker preview so the user can pick the agent.
 *   2. POST /api/separate    { url, transcript, agentSpeaker, head, tail }
 *        -> downloads the audio, mutes the agent-solo regions with ffmpeg,
 *           and streams back the resulting audio file.
 *
 * Everything is ephemeral: transcripts live in the browser only, and audio is
 * processed in a per-request temp dir that is deleted right after streaming.
 * The server keeps no state, which suits Cloud Run's stateless model.
 */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { transcribe, buildSpeakerPreview } = require("./lib/scribe");
const { computeMuteRegions, buildVolumeFilter } = require("./lib/mute");

const app = express();

// ---- HTTP Basic auth (test gate) -----------------------------------------
// Enabled when BASIC_AUTH_USER + BASIC_AUTH_PASS are set. Keeps this PoC from
// being wide open on a public Cloud Run URL.
const BA_USER = process.env.BASIC_AUTH_USER;
const BA_PASS = process.env.BASIC_AUTH_PASS;
if (BA_USER && BA_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    const [scheme, encoded] = hdr.split(" ");
    if (scheme === "Basic" && encoded) {
      const [u, p] = Buffer.from(encoded, "base64").toString().split(":");
      if (u === BA_USER && p === BA_PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="AudioSeparator"');
    res.status(401).send("Authentication required.");
  });
}

app.use(express.json({ limit: "8mb" })); // transcripts can be a few hundred KB
app.use(express.static(path.join(__dirname, "public")));

// ---- 1) transcribe -------------------------------------------------------
app.post("/api/transcribe", async (req, res) => {
  try {
    const { url, language } = req.body || {};
    if (!url || !/^https?:\/\//.test(url)) {
      return res.status(400).json({ error: "A valid http(s) audio URL is required." });
    }
    const transcript = await transcribe(url, language ? { language } : {});
    const preview = buildSpeakerPreview(transcript);
    res.json({
      duration_sec: transcript.duration_sec,
      model: transcript.model,
      preview,
      transcript, // returned so the client can hand it back for separation
    });
  } catch (err) {
    console.error("transcribe error:", err);
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---- 2) separate ---------------------------------------------------------
app.post("/api/separate", async (req, res) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audiosep-"));
  const inPath = path.join(workDir, "in");
  const outPath = path.join(workDir, "out.m4a");
  const cleanup = () => fs.rm(workDir, { recursive: true, force: true }, () => {});

  try {
    const { url, transcript, agentSpeaker, head, tail } = req.body || {};
    const segments = transcript?.result?.segments;
    if (!url || !Array.isArray(segments) || !agentSpeaker) {
      cleanup();
      return res.status(400).json({ error: "url, transcript and agentSpeaker are required." });
    }

    // download the source audio (same URL the transcript came from)
    const srcRes = await fetch(url);
    if (!srcRes.ok) throw new Error(`Failed to fetch audio: ${srcRes.status}`);
    await fs.promises.writeFile(inPath, Buffer.from(await srcRes.arrayBuffer()));

    const { regions, totalMuted } = computeMuteRegions(segments, agentSpeaker, {
      head: Number.isFinite(head) ? head : undefined,
      tail: Number.isFinite(tail) ? tail : undefined,
      duration: transcript.duration_sec,
    });
    const filter = buildVolumeFilter(regions);

    await runFfmpeg(["-y", "-i", inPath, "-af", filter, "-c:a", "aac", outPath]);

    res.setHeader("Content-Type", "audio/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="customer_only.m4a"');
    res.setHeader("X-Mute-Regions", String(regions.length));
    res.setHeader("X-Mute-Seconds", totalMuted.toFixed(1));
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on("close", cleanup);
    stream.on("error", (e) => {
      console.error("stream error:", e);
      cleanup();
    });
  } catch (err) {
    console.error("separate error:", err);
    cleanup();
    res.status(502).json({ error: String(err.message || err) });
  }
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))
    );
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`AudioSeparator listening on :${PORT}`));
