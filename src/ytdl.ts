import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitize, TG_LIMIT, type DownloadResult } from "./sc.js";

const TIMEOUT_MS = 10 * 60 * 1000;

export function downloadAudio(url: string): Promise<DownloadResult> {
  const dir = mkdtempSync(join(tmpdir(), "mbot-"));
  return run(dir, url).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function run(dir: string, url: string): Promise<DownloadResult> {
  const args = [
    "--js-runtimes", "node", // solves YouTube JS challenges; bot always runs under node
    "--no-playlist",
    "--max-filesize", "50M",
    "-f", "bestaudio",
    "-x", "--audio-format", "m4a",
    "--no-progress", "--dump-json", "--no-simulate", // -j alone implies simulate: no download
    "-o", join(dir, "%(id)s.%(ext)s"),
    "--", url, // -- prevents option injection via URL
  ];
  const { code, out, err } = await spawnYtDlp(args);
  if (code !== 0) throw new Error(errorLine(out, err));
  return collect(dir, out);
}

/** Enumerate playlist entries without downloading (flat = no per-video extraction). */
export async function listPlaylist(
  url: string,
): Promise<{ title: string; entries: { url: string; title: string }[] }> {
  const args = [
    "--js-runtimes", "node",
    "--flat-playlist", "--dump-json",
    "--", url,
  ];
  const { code, out, err } = await spawnYtDlp(args);
  if (code !== 0) throw new Error(errorLine(out, err));
  let title = "YouTube playlist";
  const entries: { url: string; title: string }[] = [];
  for (const line of out.split("\n").map((l) => l.trim())) {
    if (!line.startsWith("{")) continue;
    const entry: unknown = JSON.parse(line);
    if (!(entry && typeof entry === "object")) continue;
    // yt-dlp flat entry shape; one-off read
    const rec = entry as { id?: unknown; url?: unknown; title?: unknown; playlist_title?: unknown };
    if (typeof rec.id !== "string" && typeof rec.url !== "string") continue;
    if (typeof rec.playlist_title === "string" && title === "YouTube playlist") title = rec.playlist_title;
    const entryUrl =
      typeof rec.url === "string" && /^https?:\/\//i.test(rec.url)
        ? rec.url
        : typeof rec.id === "string"
          ? `https://www.youtube.com/watch?v=${rec.id}`
          : null;
    if (entryUrl) {
      entries.push({ url: entryUrl, title: typeof rec.title === "string" ? rec.title : `Track ${entries.length + 1}` });
    }
  }
  if (entries.length === 0) throw new Error("yt-dlp: playlist is empty or unsupported");
  return { title, entries };
}

function spawnYtDlp(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const { promise, resolve: resolvePromise, reject: rejectPromise } =
    Promise.withResolvers<{ code: number | null; out: string; err: string }>();
  const child = spawn("yt-dlp", args);
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
  let out = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => (out += c));
  child.stderr.on("data", (c: Buffer) => (err += c));
  child.on("error", (e) => {
    clearTimeout(timer);
    rejectPromise(new Error(`yt-dlp spawn failed: ${e.message}`));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolvePromise({ code, out, err });
  });
  return promise;
}

function errorLine(out: string, err: string): string {
  const last = (out + "\n" + err).split("\n").filter((l) => l.trim()).pop() ?? "unknown error";
  return `yt-dlp: ${last.trim().slice(0, 200)}`;
}

function collect(dir: string, out: string): DownloadResult {
  const jsonLine = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
  if (!jsonLine) throw new Error("yt-dlp: no metadata in output");
  const info: unknown = JSON.parse(jsonLine);
  if (!(info && typeof info === "object")) throw new Error("yt-dlp: bad metadata");
  // --dump-json shape; single consumer, one-off read
  const meta = info as { title?: unknown; uploader?: unknown; duration?: unknown };
  const title = typeof meta.title === "string" ? meta.title : "audio";
  const performer = typeof meta.uploader === "string" ? meta.uploader : "";

  const file = readdirSync(dir).find((f) => f.endsWith(".m4a"));
  if (!file) throw new Error("File too large or no audio stream");
  const audio = readFileSync(join(dir, file));
  if (audio.length > TG_LIMIT) throw new Error("File too large for Telegram (50 MB)");

  return {
    audio,
    filename: sanitize(`${performer} - ${title}`) + file.slice(file.lastIndexOf(".")),
    title,
    performer,
    durationSec: typeof meta.duration === "number" ? Math.round(meta.duration) : 0,
    thumb: null,
  };
}
