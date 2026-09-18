"use strict";
/**
 * Mute-region computation for the "keep customer, mute agent" separation.
 *
 * Pure functions over transcript segments — no I/O — so they're easy to test
 * and reuse from both the CLI PoC and the web server.
 *
 * Strategy (mono mix, JSON + ffmpeg only, no source separation):
 *   mute = AGENT intervals  MINUS  anything overlapping a CUSTOMER interval
 *   -> only agent-SOLO time is muted; double-talk stays audible (customer wins).
 * Then grow each region by head/tail offsets to catch onset/tail leak that the
 * ASR timecodes trimmed, and RE-SUBTRACT customer intervals so the growth can
 * never clip the customer.
 */

const DEFAULTS = {
  head: 0.2, // extend mute region start earlier (seconds)
  tail: 0.12, // extend mute region end later (seconds)
  mergeGap: 0.15, // merge mute regions closer than this
  minMute: 0.15, // drop mute regions shorter than this
};

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

/**
 * @param {Array<{start:number,end:number,speaker:string}>} segments
 * @param {string} agentSpeaker  speaker label to MUTE (e.g. "Speaker 1")
 * @param {object} opts  { head, tail, mergeGap, minMute, duration }
 * @returns {{regions:Array<{start:number,end:number}>, totalMuted:number,
 *            agentCount:number, customerCount:number}}
 */
function computeMuteRegions(segments, agentSpeaker, opts = {}) {
  const { head, tail, mergeGap, minMute } = { ...DEFAULTS, ...opts };
  const duration = opts.duration ?? Infinity;

  const agent = [];
  const customer = [];
  for (const s of segments) {
    const iv = { start: s.start, end: s.end };
    if (s.speaker === agentSpeaker) agent.push(iv);
    else customer.push(iv);
  }

  // 1) agent-solo mute regions
  let mute = [];
  for (const a of agent) mute.push(...subtract(a, customer));

  // 2) grow by head/tail, clamp to media bounds
  mute = mute.map((m) => ({
    start: Math.max(0, m.start - head),
    end: Math.min(duration, m.end + tail),
  }));

  // 3) re-subtract customer so growth never eats customer speech
  let safe = [];
  for (const m of mute) safe.push(...subtract(m, customer));

  // 4) sort + merge near-adjacent, then drop tiny
  safe.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const m of safe) {
    const last = merged[merged.length - 1];
    if (last && m.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, m.end);
    } else {
      merged.push({ ...m });
    }
  }
  const regions = merged.filter((m) => m.end - m.start >= minMute);
  const totalMuted = regions.reduce((a, m) => a + (m.end - m.start), 0);

  return { regions, totalMuted, agentCount: agent.length, customerCount: customer.length };
}

// build an ffmpeg `volume` filter that silences all mute regions
function buildVolumeFilter(regions) {
  if (!regions.length) return "anull";
  const enable = regions
    .map((m) => `between(t,${m.start.toFixed(3)},${m.end.toFixed(3)})`)
    .join("+");
  return `volume=enable='${enable}':volume=0`;
}

module.exports = { computeMuteRegions, buildVolumeFilter, DEFAULTS };
