"use strict";
/**
 * AudioSeparator — PoC web server.
 *
 * Flow:
 *   0. POST /api/upload      (multipart "file")
 *        -> stores the audio in an ephemeral uploads dir, returns { uploadId }.
 *   1. POST /api/transcribe  { url } | { uploadId }
 *        -> calls Zoom Scribe (sync, diarization) and returns the transcript
 *           plus a per-speaker preview so the user can pick the agent.
 *           URL sources are sent by URL; uploads are sent as base64 bytes.
 *   2. POST /api/separate    { url|uploadId, transcript, agentSpeaker, head, tail }
 *        -> gets the audio (download or local upload), mutes the agent-solo
 *           regions with ffmpeg, and streams back the resulting audio file.
 *
 * Everything is ephemeral: transcripts live in the browser only, uploads sit in
 * a temp dir that is purged (old files) and dies with the container, and each
 * separation runs in a per-request temp dir deleted right after streaming.
 */

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { transcribe, buildSpeakerPreview } = require("./lib/scribe");
const { computeMuteRegions } = require("./lib/mute");
const { renderMuted } = require("./lib/render");

const app = express();
app.set("trust proxy", true); // Cloud Run sits behind a proxy (X-Forwarded-*)

// ---- ephemeral uploads store ---------------------------------------------
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "audiosep-uploads-"));
const UPLOAD_TTL_MS = 60 * 60 * 1000; // purge uploads older than 1h
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // Scribe sync limit is 100MB

// best-effort age-based purge (runs on each upload)
function purgeOldUploads() {
  const now = Date.now();
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, name);
    try {
      if (now - fs.statSync(p).mtimeMs > UPLOAD_TTL_MS) fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// resolve an uploadId to a safe absolute path inside UPLOAD_DIR
function uploadPath(uploadId) {
  if (typeof uploadId !== "string" || !/^[a-f0-9]{32}(\.[a-z0-9]+)?$/i.test(uploadId)) return null;
  const p = path.join(UPLOAD_DIR, path.basename(uploadId));
  return fs.existsSync(p) ? p : null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
      cb(null, crypto.randomBytes(16).toString("hex") + ext);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ---- HTTP Basic auth (test gate) -----------------------------------------
// Enabled when BASIC_AUTH_USER + BASIC_AUTH_PASS are set. Keeps this PoC from
// being wide open on a public Cloud Run URL.
const BA_USER = process.env.BASIC_AUTH_USER;
const BA_PASS = process.env.BASIC_AUTH_PASS;
if (BA_USER && BA_PASS) {
  app.use((req, res, next) => {
    // /f/:id is a capability URL (128-bit random id) so Zoom Scribe can fetch
    // an uploaded file without Basic credentials. Exempt it from the gate.
    if (req.path.startsWith("/f/")) return next();
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

// ---- 0) upload -----------------------------------------------------------
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  purgeOldUploads();
  res.json({ uploadId: req.file.filename, name: req.file.originalname, size: req.file.size });
});

// public capability route: serves an uploaded file so Zoom Scribe can fetch it
// by URL (with a real extension). Exempt from Basic auth; id is 128-bit random.
app.get("/f/:id", (req, res) => {
  const p = uploadPath(req.params.id);
  if (!p) return res.status(404).send("Not found.");
  res.sendFile(p); // Content-Type inferred from the extension in the filename
});

// ---- 1) transcribe -------------------------------------------------------
app.post("/api/transcribe", async (req, res) => {
  try {
    const { url, uploadId, language } = req.body || {};
    let source;
    if (uploadId) {
      const p = uploadPath(uploadId);
      if (!p) return res.status(400).json({ error: "Unknown or expired uploadId." });
      // hand Scribe a public URL to our own capability route (it needs a real
      // file extension, which base64 payloads don't carry).
      source = `${req.protocol}://${req.get("host")}/f/${uploadId}`;
    } else if (url && /^https?:\/\//.test(url)) {
      source = url;
    } else {
      return res.status(400).json({ error: "A valid audio URL or uploadId is required." });
    }

    const transcript = await transcribe(source, language ? { language } : {});
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
    const { url, uploadId, transcript, agentSpeaker, head, tail } = req.body || {};
    const segments = transcript?.result?.segments;
    if (!Array.isArray(segments) || !agentSpeaker) {
      cleanup();
      return res.status(400).json({ error: "transcript and agentSpeaker are required." });
    }

    // obtain the source audio: local upload, or download from URL
    if (uploadId) {
      const p = uploadPath(uploadId);
      if (!p) {
        cleanup();
        return res.status(400).json({ error: "Unknown or expired uploadId." });
      }
      await fs.promises.copyFile(p, inPath);
    } else if (url && /^https?:\/\//.test(url)) {
      const srcRes = await fetch(url);
      if (!srcRes.ok) throw new Error(`Failed to fetch audio: ${srcRes.status}`);
      await fs.promises.writeFile(inPath, Buffer.from(await srcRes.arrayBuffer()));
    } else {
      cleanup();
      return res.status(400).json({ error: "A valid audio URL or uploadId is required." });
    }

    const { regions, totalMuted } = computeMuteRegions(segments, agentSpeaker, {
      head: Number.isFinite(head) ? head : undefined,
      tail: Number.isFinite(tail) ? tail : undefined,
      duration: transcript.duration_sec,
    });

    await renderMuted(inPath, outPath, regions);

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`AudioSeparator listening on :${PORT}`));
