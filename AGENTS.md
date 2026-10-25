# AGENTS.md

Guide for coding agents working in this repo.

## Stack

- grammY (Telegram bot framework), TypeScript compiled with `tsc` to `dist/`, ESM (`"type": "module"`, `NodeNext`).
- Runtime: Node ≥ 20 (uses `Promise.withResolvers`, top-level await, global `fetch`).
- External binary: `yt-dlp` (+ `ffmpeg` for postprocessing) — required only for YouTube, never for SoundCloud.

## Layout

- `src/sc.ts` — SoundCloud client, pure `fetch` (no deps): `client_id` scrape → `resolve` → HLS fMP4 concat. Owns `TG_LIMIT` (49 MB) and `sanitize()`.
- `src/ytdl.ts` — yt-dlp wrapper (spawn, no shell). Temp dir per download, cleaned in `finally`.
- `src/bot.ts` — routing regexes, handlers, `sendAudioSafe`. English UI strings are literals here.
- `src/main.ts` — entry: env check, `bot.init()`, long polling via `bot.start()` (not awaited).
- `Dockerfile` — multi-stage; runtime installs `yt-dlp` via **pip**, not apt (apt's version breaks on YouTube changes).

## Build / run / verify

```
npm run build          # must be clean; outputs dist/
BOT_TOKEN= npm run dev # prints "BOT_TOKEN is not set", exit 1
docker compose up -d --build && docker compose logs -f bot
```

For a live end-to-end check you need a real `BOT_TOKEN` in `.env`. Without it, verify the SoundCloud chain headlessly (no token needed):

```
node -e "import('./dist/sc.js').then(s => s.resolve('https://soundcloud.com/forss/flickermood').then(t => console.log(t.title)))"
```

## Non-obvious invariants (do not break)

1. **yt-dlp needs `--no-simulate`** when `--dump-json` is used: `-j` alone implies simulate mode — yt-dlp prints metadata and *silently downloads nothing*, exit 0. Symptom: "File too large or no audio stream".
2. **`--js-runtimes node`**: modern yt-dlp requires a JS runtime for YouTube extraction; without it YouTube degrades to HLS-only formats and fails intermittently. The bot always runs under node, so the flag is safe everywhere.
3. **Routing regexes**: `watch?v=` has no trailing slash (`youtube\.com\/watch\?`), `on.soundcloud.com` must stay in the host match — otherwise links fall through to the fallback hint or get a truncated host. Covered cases: `www./m./music.` prefixes, `shorts/`, `live/`, `playlist?`, `youtu.be/`. A URL containing `playlist?` goes through `listPlaylist` (flat enumeration, then per-entry `downloadAudio`); `watch?v=…&list=…` deliberately stays a single video.
4. **Transcoding URL needs `client_id` appended** (`transcoding.url?client_id=…`) — 401 without it. On 401/403 from SoundCloud, re-scrape the id once and retry (id expires periodically).
5. **Telegram limit**: bots cannot `sendAudio` > 50 MB (server-side). `TG_LIMIT` is 49 MB by design; SC falls back `sq`→`lq`, never strip this guard.
6. **`--` before the URL** in the yt-dlp argv — prevents option injection via crafted URLs.
7. `sendAudioSafe` retries without thumbnail on failure (covers can exceed Telegram's 200 KB thumbnail limit); title/performer are truncated to 64 chars (Telegram API limit).
8. Playlist download is sequential by design (grammY processes updates sequentially; parallel sends would spam). Max 30 tracks (`MAX_PLAYLIST_TRACKS`); per-track errors are counted, not fatal.
9. **Whitelist**: `WHITELIST` env (comma-separated numeric user IDs) gates everything via the first middleware in `registerHandlers` — empty/unset means public. Denials: reply in private chats, silence in groups.
10. **Playlist selection state** lives in the in-memory `selections` map keyed `"chatId:userId"` (one-shot, TTL 5 min — `SELECTION_TTL_MS`, lost on restart — no DB by design). Track-number replies are matched by `SELECTION_RE` and must stay silent in groups when no pending selection exists.
11. **Technical messages self-delete** via `deleteLater` 15 s after appearing (`AUTO_DELETE_MS`): final `✅ Sent M/N` status, `❌` errors, selection hints. Schedule deletion only on the *final* state of a message — the `⏳` progress message is the same message id and must survive until the download finishes. Interactive selection menus are never auto-deleted.

## Conventions

- No DB, no webhooks, no i18n: long polling, in-memory, English literals in `bot.ts`.
- Prefer extending the existing two regexes / `sc.ts` chain over adding dependencies. New supported sites: extend a regex in `bot.ts` and route to `ytdl.ts`.
- Keep `npm run build` green after every change; each source change should be verified against the real services (SoundCloud/YouTube are live-checked, not mocked).
