"use strict";
/**
 * Zoom AI Services — Scribe (synchronous) client.
 *
 * Auth: Zoom Build Platform API Key / Secret, signed as a short-lived JWT
 * (HS256) on every request. Set these env vars:
 *   ZOOM_API_KEY, ZOOM_API_SECRET
 *
 * Endpoint: POST https://api.zoom.us/v2/aiservices/scribe/transcribe
 * The file is passed by URL (must be reachable by Zoom, e.g. a public GCS URL),
 * matching the request body shape confirmed to work against this endpoint.
 */

const crypto = require("crypto");

const API_BASE = process.env.ZOOM_API_BASE || "https://api.zoom.us/v2";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/**
 * Build a short-lived Zoom JWT from the API key/secret.
 * Payload: { iss: <apiKey>, iat, exp }, signed HS256 with the secret.
 */
function getAccessToken(ttlSec = 300) {
  const { ZOOM_API_KEY, ZOOM_API_SECRET } = process.env;
  if (!ZOOM_API_KEY || !ZOOM_API_SECRET) {
    throw new Error("Missing Zoom Build Platform env vars (ZOOM_API_KEY, ZOOM_API_SECRET).");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: ZOOM_API_KEY, iat: now, exp: now + ttlSec };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = b64url(crypto.createHmac("sha256", ZOOM_API_SECRET).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/**
 * Transcribe an audio file (by URL) with diarization.
 * @param {string} fileUrl  publicly reachable audio URL
 * @param {object} configOverride  merged over the default Scribe config
 * @returns {Promise<object>} raw Scribe response (request_id, duration_sec, result, ...)
 */
async function transcribe(fileUrl, configOverride = {}) {
  const token = getAccessToken();
  const body = {
    config: {
      language: "ja-JP",
      timestamps: true,
      word_time_offsets: false,
      channel_separation: false,
      diarization: true,
      profanity_filter: false,
      output_format: "json",
      ...configOverride,
    },
    file: fileUrl,
  };

  const res = await fetch(`${API_BASE}/aiservices/scribe/transcribe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Scribe transcribe failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Build a per-speaker preview so the user can decide which speaker is the agent.
 * Diarization emits exactly two labels; we don't assume their names.
 * @param {object} transcript  Scribe response
 * @param {number} turns  how many opening turns to show per speaker
 */
function buildSpeakerPreview(transcript, turns = 3) {
  const segments = transcript?.result?.segments || [];
  const bySpeaker = new Map(); // label -> { label, count, totalSec, firstStart, opening[] }

  for (const s of segments) {
    const label = s.speaker || "unknown";
    if (!bySpeaker.has(label)) {
      bySpeaker.set(label, {
        label,
        count: 0,
        totalSec: 0,
        firstStart: s.start,
        opening: [],
      });
    }
    const e = bySpeaker.get(label);
    e.count += 1;
    e.totalSec += Math.max(0, s.end - s.start);
    if (e.opening.length < turns) {
      e.opening.push({ start: s.start, end: s.end, text: s.text });
    }
  }

  // order speakers by when they first appear in the call
  return [...bySpeaker.values()]
    .sort((a, b) => a.firstStart - b.firstStart)
    .map((e) => ({
      label: e.label,
      segmentCount: e.count,
      totalSpeakingSec: Number(e.totalSec.toFixed(1)),
      opening: e.opening,
    }));
}

module.exports = { transcribe, buildSpeakerPreview, getAccessToken };
