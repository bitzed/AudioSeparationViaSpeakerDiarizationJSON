#!/usr/bin/env node
/**
 * mute-agent.js
 *
 * Proof-of-concept: mute the AGENT's solo speech in a mono call recording,
 * keeping the CUSTOMER's speech (and any double-talk) intact.
 *
 * Strategy (JSON + ffmpeg only, no source separation):
 *   1. Read transcription.json segments (start/end/speaker).
 *   2. Split segments into AGENT vs CUSTOMER by speaker label.
 *   3. Mute regions = AGENT intervals MINUS anything overlapping a CUSTOMER
 *      interval. i.e. only agent-SOLO time is muted; double-talk is kept.
 *   4. Grow each mute region by HEAD/TAIL offsets to catch speech that the
 *      ASR timecodes trimmed (leading onset leaks, trailing tails), then
 *      RE-SUBTRACT customer intervals so growth can never clip the customer.
 *   5. Apply as an ffmpeg `volume=0:enable=...` filter.
 *
 * Usage:
 *   node mute-agent.js [input.mp4] [transcription.json] [output.m4a]
 *                      [--head 0.2] [--tail 0.12]
 *
 *   --head  seconds to extend each mute region EARLIER (catch agent onset leak)
 *   --tail  seconds to extend each mute region LATER  (catch agent tail leak)
 */

const fs = require("fs");
const { spawnSync } = require("child_process");

// ---- config (hardcoded for this PoC; AI role detection comes later) --------
const AGENT_SPEAKER = "Speaker 1"; // muted; everything else = customer / keep

// Defaults. ~4/24f of onset leak reported => head default ~0.20s.
let HEAD = 0.2; // extend mute region start earlier (seconds)
let TAIL = 0.12; // extend mute region end later (seconds)
const MERGE_GAP = 0.15; // merge mute regions closer than this
const MIN_MUTE = 0.15; // drop mute regions shorter than this
// ----------------------------------------------------------------------------

// --- arg parsing: positionals + --head/--tail flags ---
const argv = process.argv.slice(2);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--head") HEAD = parseFloat(argv[++i]);
  else if (argv[i] === "--tail") TAIL = parseFloat(argv[++i]);
  else positional.push(argv[i]);
}
const INPUT = positional[0] || "CID707078997815_mono.mp4";
const JSON_PATH = positional[1] || "transcription.json";
const OUTPUT = positional[2] || "output_customer_only.m4a";

const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const DURATION = data.duration_sec;
const segments = data.result.segments;

const agent = [];
const customer = [];
for (const s of segments) {
  const iv = { start: s.start, end: s.end };
  if (s.speaker === AGENT_SPEAKER) agent.push(iv);
  else customer.push(iv);
}

// subtract a set of "cut" intervals from a single base interval
function subtract(base, cuts) {
  let pieces = [base];
  for (const c of cuts) {
    const next = [];
    for (const p of pieces) {
      if (c.end <= p.start || c.start >= p.end) {
        next.push(p); // no overlap
        continue;
      }
      if (c.start > p.start) next.push({ start: p.start, end: c.start });
      if (c.end < p.end) next.push({ start: c.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

// 1) agent-solo mute regions
let mute = [];
for (const a of agent) mute.push(...subtract(a, customer));

// 2) grow by head/tail offsets, clamp to media bounds
mute = mute.map((m) => ({
  start: Math.max(0, m.start - HEAD),
  end: Math.min(DURATION, m.end + TAIL),
}));

// 3) RE-SUBTRACT customer intervals so growth never eats customer speech
let safe = [];
for (const m of mute) safe.push(...subtract(m, customer));

// 4) sort + merge near-adjacent, then drop tiny
safe.sort((a, b) => a.start - b.start);
const merged = [];
for (const m of safe) {
  const last = merged[merged.length - 1];
  if (last && m.start - last.end <= MERGE_GAP) {
    last.end = Math.max(last.end, m.end);
  } else {
    merged.push({ ...m });
  }
}
const final = merged.filter((m) => m.end - m.start >= MIN_MUTE);

// report
const totalMute = final.reduce((a, m) => a + (m.end - m.start), 0);
console.log(`head=${HEAD}s tail=${TAIL}s`);
console.log(`segments: ${segments.length} (agent=${agent.length}, customer=${customer.length})`);
console.log(`mute regions: ${final.length}, total muted: ${totalMute.toFixed(1)}s / ${DURATION}s`);

// build ffmpeg volume enable expression: volume=0 while inside any mute region
const enable = final
  .map((m) => `between(t,${m.start.toFixed(3)},${m.end.toFixed(3)})`)
  .join("+");

const filter = `volume=enable='${enable}':volume=0`;

const args = ["-y", "-i", INPUT, "-af", filter, "-c:a", "aac", OUTPUT];

console.log(`\nrunning ffmpeg -> ${OUTPUT}`);
const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
if (r.status !== 0) {
  process.stderr.write(r.stderr.toString());
  process.exit(r.status || 1);
}
console.log("done.");
