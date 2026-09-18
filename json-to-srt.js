#!/usr/bin/env node
/**
 * json-to-srt.js
 *
 * Convert a Zoom Scribe transcription JSON into an SRT subtitle file that
 * DaVinci Resolve (or any NLE) can import onto the timeline. Handy for
 * eyeballing where each speaker talks vs. the muted audio.
 *
 * Usage:
 *   node json-to-srt.js [transcription.json] [output.srt] [--no-speaker]
 *
 *   --no-speaker   omit the "Speaker N: " prefix from each cue
 */

const fs = require("fs");

const argv = process.argv.slice(2);
const showSpeaker = !argv.includes("--no-speaker");
const positional = argv.filter((a) => !a.startsWith("--"));
const JSON_PATH = positional[0] || "transcription.json";
const OUTPUT = positional[1] || JSON_PATH.replace(/\.json$/i, "") + ".srt";

// seconds -> "HH:MM:SS,mmm"
function ts(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
}

const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const segments = data.result.segments;

const lines = [];
let i = 1;
for (const seg of segments) {
  // guard against zero/negative-length cues (Resolve rejects them)
  const end = seg.end > seg.start ? seg.end : seg.start + 0.3;
  const text = showSpeaker && seg.speaker ? `${seg.speaker}: ${seg.text}` : seg.text;
  lines.push(String(i++));
  lines.push(`${ts(seg.start)} --> ${ts(end)}`);
  lines.push(text);
  lines.push(""); // blank line between cues
}

fs.writeFileSync(OUTPUT, lines.join("\n"), "utf8");
console.log(`wrote ${OUTPUT} (${segments.length} cues, speaker prefix: ${showSpeaker})`);
