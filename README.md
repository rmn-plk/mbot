# mbot — Telegram audio downloader

Sends back audio (`.m4a`) for SoundCloud and YouTube links. grammY, long polling, no server, no DB.

## Run (Docker)

1. Get a token from [@BotFather](https://t.me/BotFather).
2. `cp .env.example .env` and put the token in `BOT_TOKEN`.
3. `docker compose up -d --build`, logs: `docker compose logs -f bot`.

## Local dev (no Docker)

```
npm i
BOT_TOKEN=... npm run dev      # or: npm run build && BOT_TOKEN=... npm start
```

SoundCloud works on plain Node. YouTube needs `yt-dlp` and `ffmpeg` in PATH.

## What it supports

- SoundCloud tracks (`soundcloud.com/<artist>/<track>`, short links `on.soundcloud.com/…`) and playlists (`/sets/…`).
- YouTube videos (`youtube.com/watch?v=…`, `youtu.be/…`, `shorts`, `live`, `music.`) and playlists (`/playlist?list=…`). A `watch?v=…&list=…` link counts as a single video, not the playlist.
- Playlists (both platforms) show a numbered track menu: reply with numbers (`1 3 5-9`) to download selected tracks, or tap "Download all". Up to 30 tracks per playlist; the selection lives in memory for 30 minutes.
- Metadata (title, performer, duration, cover) is passed as `sendAudio` parameters; no tags are written into files.
- Hard limit: 50 MB — the Telegram Bot API ceiling for bots. Oversized SC tracks fall back from `sq` to `lq` quality; YouTube downloads >50 MB are rejected.

## Groups

For the bot to see links in groups, disable privacy mode via @BotFather (`/setprivacy` → Disable). In groups the bot reacts only to matching links and stays silent on other text.

## Whitelist

Set `WHITELIST` in `.env` to a comma-separated list of Telegram user IDs (get yours from @userinfobot) — then only those users can use the bot. Empty/unset = open to everyone. Apply changes with `docker compose up -d`.

## How it works

- **SoundCloud** (`src/sc.ts`): no external deps. Scrapes `client_id` from the site's JS bundles (auto-refresh on 401/403), resolves via `api-v2.soundcloud.com/resolve`, downloads the HLS fMP4 playlist (`init.mp4` + segments) and concatenates them in memory — the result is a valid `.m4a`. Progressive MP3 is deprecated by SoundCloud; ffmpeg is not needed.
- **YouTube** (`src/ytdl.ts`): spawns `yt-dlp -f bestaudio -x --audio-format m4a` into a temp dir, reads the file, cleans up. Notable flags: `--no-simulate` (`--dump-json` alone implies simulate → no download), `--js-runtimes node` (yt-dlp needs a JS runtime for YouTube challenges), `--` before the URL (option-injection guard), 10 min timeout.
- **Routing** (`src/bot.ts`): two regexes (`SC_RE`, `YT_RE`) via `bot.hears`; order matters — the catch-all private-chat hint is registered last.

## Notes

- The Docker image installs yt-dlp via pip on purpose: apt's version is outdated and breaks on YouTube changes.
- Files are not stored: SoundCloud audio is assembled in RAM; YouTube audio lives in a temp dir only for the duration of the download.
