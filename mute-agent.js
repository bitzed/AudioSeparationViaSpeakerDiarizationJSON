#!/usr/bin/env node
/**
 * mute-agent.js — CLI proof-of-concept.
 *
 * Mute the AGENT's solo speech in a mono call recording, keeping the CUSTOMER's
 * speech (and any double-talk) audible. Uses the same shared logic as the web
 * app: lib/mute (region math) + lib/render (PCM-based muting, safe for calls
 * with many regions).
 *
 * Usage:
 *   node mute-agent.js [input.mp4] [transcription.json] [output.m4a]
 *                      [--head 0.2] [--tail 0.12] [--agent "Speaker 1"]
 */

const fs = require("fs");
const { computeMuteRegions } = require("./lib/mute");
const { renderMuted } = require("./lib/render");

// --- arg parsing: positionals + flags ---
const argv = process.argv.slice(2);
const positional = [];
const opts = { agent: "Speaker 1" };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--head") opts.head = parseFloat(argv[++i]);
  else if (argv[i] === "--tail") opts.tail = parseFloat(argv[++i]);
  else if (argv[i] === "--agent") opts.agent = argv[++i];
  else positional.push(argv[i]);
}
const INPUT = positional[0] || "CID707078997815_mono.mp4";
const JSON_PATH = positional[1] || "transcription.json";
const OUTPUT = positional[2] || "output_customer_only.m4a";

(async () => {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const segments = data.result.segments;

  const { regions, totalMuted, agentCount, customerCount } = computeMuteRegions(
    segments,
    opts.agent,
    { head: opts.head, tail: opts.tail, duration: data.duration_sec }
  );

  console.log(`agent="${opts.agent}" head=${opts.head ?? 0.2}s tail=${opts.tail ?? 0.12}s`);
  console.log(`segments: ${segments.length} (agent=${agentCount}, customer=${customerCount})`);
  console.log(
    `mute regions: ${regions.length}, total muted: ${totalMuted.toFixed(1)}s / ${data.duration_sec}s`
  );

  console.log(`\nrendering -> ${OUTPUT}`);
  await renderMuted(INPUT, OUTPUT, regions);
  console.log("done.");
})().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
