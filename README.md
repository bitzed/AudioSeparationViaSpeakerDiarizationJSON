# AudioSeparator

Transcribe a call recording with **Zoom AI Services — Scribe** (speaker
diarization), pick which speaker is the **agent**, and download an audio file
with the agent's *solo* speech muted. The customer's speech — and any
**double-talk** (both speaking at once) — stays audible.

This is a proof-of-concept. It works on a **mono mixed** recording (both
parties on one channel) using only the transcript timecodes + `ffmpeg`; there
is no acoustic source separation. Double-talk is therefore *kept* (customer
wins) rather than un-mixed.

---

> ⚠️ The following sample application is a personal, open-source project shared
> by the app creator and not an officially supported Zoom Communications, Inc.
> sample application. Zoom Communications, Inc., its employees and affiliates
> are not responsible for the use and maintenance of this application. Please
> use this sample application for inspiration, exploration and experimentation
> at your own risk and enjoyment. You may reach out to the app creator and
> broader Zoom Developer community on https://devforum.zoom.us/ for technical
> discussion and assistance, but understand there is no service level agreement
> support for this application. Thank you and happy coding!

> ⚠️ このサンプルのアプリケーションは、Zoom Communications, Inc.の公式にサポート
> されているものではなく、アプリ作成者が個人的に公開しているオープンソースプロ
> ジェクトです。Zoom Communications, Inc.とその従業員、および関連会社は、本アプリ
> ケーションの使用や保守について責任を負いません。このサンプルアプリケーションは、
> あくまでもインスピレーション、探求、実験のためのものとして、ご自身の責任と楽しみ
> の範囲でご活用ください。技術的な議論やサポートが必要な場合は、アプリ作成者やZoom
> 開発者コミュニティ（ https://devforum.zoom.us/ ）にご連絡いただけますが、この
> アプリケーションにはサービスレベル契約に基づくサポートがないことをご理解ください。
> ありがとうございます。楽しいコーディングを！

---

## How it works

1. **Transcribe** — `POST /api/transcribe { url }` calls Zoom Scribe
   (synchronous, `diarization: true`) against a publicly reachable audio URL
   (e.g. a GCS object URL) and returns the transcript plus a per-speaker
   preview (opening turns, turn count, speaking time).
2. **Pick the agent** — diarization always emits two labels (`Speaker 1` /
   `Speaker 2`). You choose which one is the agent; their solo speech is muted.
3. **Separate** — `POST /api/separate` downloads the audio and mutes the
   agent-solo regions with `ffmpeg`, then streams back the result to play &
   download.

### Muting logic

```
mute = AGENT intervals  MINUS  anything overlapping a CUSTOMER interval
```

Only agent-**solo** time is muted, so double-talk stays audible. Each mute
region is then grown by **head/tail offsets** to catch onset/tail speech that
the ASR timecodes trimmed, and customer intervals are subtracted a second time
so the growth can never clip the customer.

All data is **ephemeral**: transcripts live in the browser tab only, and audio
is processed in a per-request temp dir that is deleted right after streaming.
The server keeps no state.

## Run locally

```bash
npm install
cp env.sample .env      # then fill in real values
npm start               # http://localhost:8080
```

### Environment

| Var | Purpose |
|-----|---------|
| `ZOOM_API_KEY` / `ZOOM_API_SECRET` | Zoom Build Platform credentials (signed as a short-lived HS256 JWT per request) |
| `ZOOM_API_BASE` | Optional API base override (default `https://api.zoom.us/v2`) |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | Enable HTTP Basic auth on the app (both required) |
| `PORT` | Listen port (Cloud Run injects this) |

## Deploy to Cloud Run

```bash
gcloud run deploy audioseparator \
  --source . \
  --region <REGION> \
  --allow-unauthenticated \
  --set-env-vars BASIC_AUTH_USER=demo,BASIC_AUTH_PASS=<pass> \
  --set-env-vars ZOOM_API_KEY=<key>,ZOOM_API_SECRET=<secret>
```

The container installs `ffmpeg` (see `Dockerfile`). Prefer Secret Manager over
`--set-env-vars` for real credentials.

## Command-line PoC tools

- `node mute-agent.js [in.mp4] [transcription.json] [out.m4a] [--head 0.2] [--tail 0.12]`
  — the muting pipeline as a standalone CLI.
- `node json-to-srt.js [transcription.json] [out.srt] [--no-speaker]`
  — export the transcript as SRT subtitles (handy for eyeballing in an NLE).

## License

MIT
