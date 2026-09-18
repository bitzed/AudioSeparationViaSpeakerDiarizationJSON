"use strict";
/**
 * Audio muting renderer.
 *
 * Instead of a giant ffmpeg `volume=enable='between()+between()+...'` filter
 * (which blows up the filter graph and OOMs on calls with hundreds of mute
 * regions), we:
 *   1. decode the source to raw PCM (s16le, native rate/channels),
 *   2. zero out the sample bytes inside each mute region in Node (linear, safe
 *      for any number of regions, exact timeline length),
 *   3. re-encode to AAC/m4a.
 */

const { spawn } = require("child_process");

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))
    );
    if (input) {
      p.stdin.on("error", () => {}); // ignore EPIPE if ffmpeg bails early
      p.stdin.end(input);
    }
  });
}

async function probeAudio(inPath) {
  const buf = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels",
    "-of", "default=nw=1:nk=1",
    inPath,
  ]);
  const [sampleRate, channels] = buf.toString().trim().split("\n").map((n) => parseInt(n, 10));
  if (!sampleRate || !channels) throw new Error("Could not probe audio stream.");
  return { sampleRate, channels };
}

/**
 * Render `inPath` to `outPath` with the given mute regions silenced.
 * @param {string} inPath
 * @param {string} outPath
 * @param {Array<{start:number,end:number}>} regions  seconds
 */
async function renderMuted(inPath, outPath, regions) {
  const { sampleRate, channels } = await probeAudio(inPath);

  // 1) decode to raw PCM s16le at native rate/channels
  const pcm = await run("ffmpeg", [
    "-v", "error",
    "-i", inPath,
    "-map", "0:a:0",
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "-ar", String(sampleRate),
    "-ac", String(channels),
    "pipe:1",
  ]);

  // 2) zero the sample bytes inside each region (interleaved frames)
  const bytesPerFrame = channels * 2; // s16 = 2 bytes/sample
  const totalFrames = Math.floor(pcm.length / bytesPerFrame);
  for (const r of regions) {
    const f0 = Math.max(0, Math.floor(r.start * sampleRate));
    const f1 = Math.min(totalFrames, Math.ceil(r.end * sampleRate));
    if (f1 > f0) pcm.fill(0, f0 * bytesPerFrame, f1 * bytesPerFrame);
  }

  // 3) re-encode to AAC/m4a
  await run(
    "ffmpeg",
    [
      "-v", "error",
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", String(channels),
      "-i", "pipe:0",
      "-c:a", "aac",
      "-y", outPath,
    ],
    { input: pcm }
  );
}

module.exports = { renderMuted, probeAudio };
