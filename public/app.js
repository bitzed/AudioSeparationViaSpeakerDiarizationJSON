"use strict";
/* AudioSeparator front-end. All state is in-memory and dies with the tab. */

const $ = (id) => document.getElementById(id);

let state = {
  transcript: null, // raw Scribe response
  url: null,
  agentSpeaker: null,
};

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

// ---- step 1: transcribe --------------------------------------------------
$("transcribeBtn").addEventListener("click", async () => {
  const url = $("url").value.trim();
  const language = $("lang").value.trim() || undefined;
  if (!url) return setStatus("transcribeStatus", "Enter a URL first.", "err");

  toggle("transcribeBtn", true);
  setStatus("transcribeStatus", "Transcribing with Zoom Scribe… (a few seconds)");
  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, language }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    state.transcript = data.transcript;
    state.url = url;
    renderSpeakers(data);
    setStatus("transcribeStatus", "Done. Pick the agent below.", "ok");
  } catch (e) {
    setStatus("transcribeStatus", `Failed: ${e.message}`, "err");
  } finally {
    toggle("transcribeBtn", false);
  }
});

// ---- step 2: render speaker preview + pick agent -------------------------
function renderSpeakers(data) {
  $("meta").textContent = `Duration ${fmtTime(data.duration_sec)} · model ${data.model || "?"}`;
  const box = $("speakers");
  box.innerHTML = "";
  state.agentSpeaker = null;
  $("separateBtn").disabled = true;

  for (const sp of data.preview) {
    const card = document.createElement("label");
    card.className = "speaker";
    const opening = sp.opening
      .map((o) => `<div class="turn"><span>${fmtTime(o.start)}</span> ${escapeHtml(o.text)}</div>`)
      .join("");
    card.innerHTML = `
      <div class="speaker-head">
        <input type="radio" name="agent" value="${escapeAttr(sp.label)}" />
        <strong>${escapeHtml(sp.label)}</strong>
        <span class="badge">${sp.segmentCount} turns · ${sp.totalSpeakingSec}s</span>
      </div>
      <div class="opening">${opening}</div>
      <div class="hint">Select = this speaker is the AGENT (muted)</div>`;
    box.appendChild(card);
  }

  box.querySelectorAll('input[name="agent"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.agentSpeaker = e.target.value;
      $("separateBtn").disabled = false;
      box.querySelectorAll(".speaker").forEach((c) =>
        c.classList.toggle("selected", c.contains(e.target))
      );
    })
  );

  show("pickSection");
}

// ---- step 3: separate ----------------------------------------------------
$("separateBtn").addEventListener("click", async () => {
  if (!state.agentSpeaker) return;
  const head = parseFloat($("head").value);
  const tail = parseFloat($("tail").value);

  toggle("separateBtn", true);
  setStatus("separateStatus", "Muting agent & rendering audio…");
  try {
    const res = await fetch("/api/separate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: state.url,
        transcript: state.transcript,
        agentSpeaker: state.agentSpeaker,
        head,
        tail,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    const regions = res.headers.get("X-Mute-Regions");
    const seconds = res.headers.get("X-Mute-Seconds");
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);

    $("player").src = objUrl;
    $("download").href = objUrl;
    $("resultMeta").textContent = `Muted ${regions} region(s), ${seconds}s of agent-solo speech.`;
    show("resultSection");
    setStatus("separateStatus", "Done.", "ok");
  } catch (e) {
    setStatus("separateStatus", `Failed: ${e.message}`, "err");
  } finally {
    toggle("separateBtn", false);
  }
});

// ---- helpers -------------------------------------------------------------
function setStatus(id, msg, kind) {
  const el = $(id);
  el.textContent = msg;
  el.className = "status" + (kind ? ` ${kind}` : "");
}
function toggle(id, disabled) {
  $(id).disabled = disabled;
}
function show(id) {
  $(id).classList.remove("hidden");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
