// SoundCloud client: client_id scrape -> resolve -> HLS fMP4 concat.
// Verified chain (2026-10): progressive MP3 is dead; HLS aac via api-v2 works.

export const TG_LIMIT = 49 * 1024 * 1024;

export interface ScTrack {
  kind: "track";
  id: number;
  title: string;
  duration: number; // ms
  streamable: boolean;
  artwork_url: string | null;
  user: { username: string };
  media: {
    transcodings: {
      url: string;
      quality: string;
      format: { mime_type: string };
    }[];
  };
}

export interface ScPlaylist {
  kind: "playlist";
  title: string;
  tracks: ScTrack[];
}

export type ScEntity = ScTrack | ScPlaylist;

export interface DownloadResult {
  audio: Buffer;
  filename: string;
  title: string;
  performer: string;
  durationSec: number;
  thumb: Buffer | null;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function sanitize(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 120);
}

// --- client_id ---

let cachedClientId: string | null = null;

async function scrapeClientId(): Promise<string> {
  const page = await fetch("https://soundcloud.com/", {
    headers: { "User-Agent": UA },
  });
  if (!page.ok) throw new Error(`soundcloud.com fetch failed: ${page.status}`);
  const html = await page.text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1])
    .slice(0, 15);
  for (const src of scripts) {
    const res = await fetch(src, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;
    const js = await res.text();
    const m = js.match(/client_id:\s*"([a-zA-Z0-9]{20,40})"/);
    if (m) return m[1];
  }
  throw new Error("Could not get SoundCloud client_id");
}

async function getClientId(): Promise<string> {
  if (!cachedClientId) cachedClientId = await scrapeClientId();
  return cachedClientId;
}

class ScAuthError extends Error {}

async function scFetch(path: string): Promise<unknown> {
  const clientId = await getClientId();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api-v2.soundcloud.com${path}${sep}client_id=${clientId}`, {
    headers: { "User-Agent": UA },
  });
  if (res.status === 401 || res.status === 403) {
    // client_id stale: refresh once and retry
    cachedClientId = await scrapeClientId();
    const retry = await fetch(`https://api-v2.soundcloud.com${path}${sep}client_id=${cachedClientId}`, {
      headers: { "User-Agent": UA },
    });
    if (!retry.ok) throw new Error(`SoundCloud API ${retry.status} for ${path}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`SoundCloud API ${res.status} for ${path}`);
  return res.json();
}

// --- public API ---

function isTrack(v: object): v is ScTrack {
  return "kind" in v && v.kind === "track" && "media" in v;
}

function isPlaylist(v: object): v is ScPlaylist {
  return "kind" in v && v.kind === "playlist" && "tracks" in v;
}

export async function resolve(url: string): Promise<ScEntity> {
  const raw: unknown = await scFetch(`/resolve?url=${encodeURIComponent(url)}`);
  if (!(raw && typeof raw === "object")) throw new Error("SoundCloud returned non-object");
  if (isTrack(raw)) return raw;
  if (isPlaylist(raw)) return raw;
  const kind = "kind" in raw ? String(raw.kind) : "unknown";
  throw new Error(`Unsupported SoundCloud kind: ${kind}`);
}

async function fetchM3u8(transcodingUrl: string): Promise<string> {
  const clientId = await getClientId();
  const sep = transcodingUrl.includes("?") ? "&" : "?";
  let res = await fetch(`${transcodingUrl}${sep}client_id=${clientId}`, {
    headers: { "User-Agent": UA },
  });
  if (res.status === 401 || res.status === 403) {
    cachedClientId = await scrapeClientId();
    res = await fetch(`${transcodingUrl}${sep}client_id=${cachedClientId}`, {
      headers: { "User-Agent": UA },
    });
  }
  if (!res.ok) throw new Error(`Transcoding fetch failed: ${res.status}`);
  const json: unknown = await res.json();
  if (!(json && typeof json === "object" && "url" in json && typeof json.url === "string")) {
    throw new Error("Transcoding response missing url");
  }
  const m3u8 = await fetch(json.url, { headers: { "User-Agent": UA } });
  if (!m3u8.ok) throw new Error(`Playlist fetch failed: ${m3u8.status}`);
  return m3u8.text();
}

async function concatHls(m3u8: string): Promise<Buffer> {
  const lines = m3u8.split("\n").map((l) => l.trim());
  const mapLine = lines.find((l) => l.startsWith("#EXT-X-MAP"));
  const initUri = mapLine?.match(/URI="([^"]+)"/)?.[1];
  const segments = lines.filter((l) => l && !l.startsWith("#"));
  if (initUri) segments.unshift(initUri);
  const parts: Buffer[] = [];
  for (const seg of segments) {
    const res = await fetch(seg, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`Segment fetch failed: ${res.status}`);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  return Buffer.concat(parts);
}

async function fetchTrackBuffer(t: ScTrack, quality: string): Promise<Buffer | null> {
  const transcoding = t.media.transcodings.find(
    (tr) => tr.format.mime_type.startsWith("audio/mp4") && tr.quality === quality,
  );
  if (!transcoding) return null;
  const m3u8 = await fetchM3u8(transcoding.url);
  return concatHls(m3u8);
}

export async function downloadTrack(t: ScTrack): Promise<DownloadResult> {
  if (!t.streamable) throw new Error("Not downloadable");
  let audio = await fetchTrackBuffer(t, "sq");
  let quality = "sq";
  if (audio && audio.length > TG_LIMIT) {
    audio = (await fetchTrackBuffer(t, "lq")) ?? null;
    quality = "lq";
  }
  if (!audio) throw new Error("No audio/mp4 transcoding available");
  if (audio.length > TG_LIMIT) throw new Error("File too large for Telegram (50 MB)");

  const performer = t.user.username;
  let thumb: Buffer | null = null;
  if (t.artwork_url) {
    try {
      const big = t.artwork_url.replace("-large.jpg", "-t500x500.jpg");
      const res = await fetch(big, { headers: { "User-Agent": UA } });
      if (res.ok) thumb = Buffer.from(await res.arrayBuffer());
    } catch {
      thumb = null;
    }
  }
  return {
    audio,
    filename: sanitize(`${performer} - ${t.title}`) + ".m4a",
    title: t.title,
    performer,
    durationSec: Math.round(t.duration / 1000),
    thumb,
  };
}
