"use strict";
/* AudioSeparator front-end. All state is in-memory and dies with the tab. */

const $ = (id) => document.getElementById(id);

let state = {
  transcript: null, // raw Scribe response
  source: null, // { url } | { uploadId }
  agentSpeaker: null,
};

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}
const activeTab = () =>
  $("tab-upload").classList.contains("active") ? "upload" : "url";

// ---- step 1: transcribe --------------------------------------------------
$("transcribeBtn").addEventListener("click", async () => {
  spin("transcribeSpin", true);
  toggle("transcribeBtn", true);
  try {
    // resolve the audio source (upload first if needed)
    if (activeTab() === "upload") {
      const f = $("file").files[0];
      if (!f) throw new Error("Choose a file first.");
      setStatus("transcribeStatus", `Uploading ${f.name}…`);
      const fd = new FormData();
      fd.append("file", f);
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const upData = await up.json();
      if (!up.ok) throw new Error(upData.error || "Upload failed.");
      state.source = { uploadId: upData.uploadId };
    } else {
      const url = $("url").value.trim();
      if (!url) throw new Error("Enter a URL first.");
      state.source = { url };
    }

    const language = $("lang").value.trim() || undefined;
    setStatus("transcribeStatus", "Transcribing with Zoom Scribe… (a few seconds)");
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...state.source, language }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    state.transcript = data.transcript;
    renderSpeakers(data);
    setStatus("transcribeStatus", "Done. Pick the agent below.", "text-success");
  } catch (e) {
    setStatus("transcribeStatus", `Failed: ${e.message}`, "text-danger");
  } finally {
    spin("transcribeSpin", false);
    toggle("transcribeBtn", false);
  }
});

$("file").addEventListener("change", () => {
  const f = $("file").files[0];
  $("uploadInfo").textContent = f ? `${f.name} · ${(f.size / 1024 / 1024).toFixed(2)} MB` : "";
});

// ---- step 2: render speaker preview + pick agent -------------------------
function renderSpeakers(data) {
  $("meta").textContent = `Duration ${fmtTime(data.duration_sec)} · model ${data.model || "?"}`;
  const box = $("speakers");
  box.innerHTML = "";
  state.agentSpeaker = null;
  $("separateBtn").disabled = true;

  for (const sp of data.preview) {
    const col = document.createElement("div");
    col.className = "col-md-6";
    const opening = sp.opening
      .map(
        (o) =>
          `<div class="turn"><span class="text-secondary me-1">${fmtTime(o.start)}</span>${escapeHtml(o.text)}</div>`
      )
      .join("");
    col.innerHTML = `
      <label class="speaker card h-100">
        <div class="card-body">
          <div class="form-check mb-2">
            <input class="form-check-input" type="radio" name="agent" value="${escapeAttr(sp.label)}" id="sp-${escapeAttr(sp.label)}" />
            <label class="form-check-label fw-semibold" for="sp-${escapeAttr(sp.label)}">${escapeHtml(sp.label)}</label>
            <span class="badge text-bg-secondary ms-1">${sp.segmentCount} turns · ${sp.totalSpeakingSec}s</span>
          </div>
          <div class="opening small">${opening}</div>
          <div class="text-secondary mt-2" style="font-size:.75rem">Select = this speaker is the AGENT (muted)</div>
        </div>
      </label>`;
    box.appendChild(col);
  }

  box.querySelectorAll('input[name="agent"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.agentSpeaker = e.target.value;
      $("separateBtn").disabled = false;
      box.querySelectorAll(".speaker").forEach((c) =>
        c.classList.toggle("border-success", c.contains(e.target))
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

  spin("separateSpin", true);
  toggle("separateBtn", true);
  setStatus("separateStatus", "Muting agent & rendering audio…");
  try {
    const res = await fetch("/api/separate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...state.source,
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
    setStatus("separateStatus", "Done.", "text-success");
  } catch (e) {
    setStatus("separateStatus", `Failed: ${e.message}`, "text-danger");
  } finally {
    spin("separateSpin", false);
    toggle("separateBtn", false);
  }
});

// ---- helpers -------------------------------------------------------------
function setStatus(id, msg, cls) {
  const el = $(id);
  el.textContent = msg;
  el.className = "small mt-2 " + (cls || "text-secondary");
}
function toggle(id, disabled) {
  $(id).disabled = disabled;
}
function spin(id, on) {
  $(id).classList.toggle("d-none", !on);
}
function show(id) {
  $(id).classList.remove("d-none");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/\s+/g, "_");
}
