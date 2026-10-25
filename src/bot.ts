import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { downloadTrack, resolve, type DownloadResult } from "./sc.js";
import { downloadAudio, listPlaylist } from "./ytdl.js";

const SC_RE = /(?:https?:\/\/)?(?:www\.|m\.|on\.)?soundcloud\.com\/[\w\-./?=&%]+/i;
const YT_RE =
  /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?|shorts\/|live\/|playlist\?)|youtu\.be\/)[\w\-./?=&%]+/i;
const SELECTION_RE = /^[\d\s,\-]+$/;
const MAX_PLAYLIST_TRACKS = 30;
const SELECTION_TTL_MS = 5 * 60 * 1000;
const HELP_TEXT =
  "Send me a SoundCloud or YouTube link — I will send back the audio as a file (up to ~50 MB, ~40 min).";

interface Pending {
  label: string;
  titles: string[];
  fetchers: (() => Promise<DownloadResult>)[];
}

// In-memory playlist selections, keyed "chatId:userId". No DB by design.
const selections = new Map<string, Pending>();

export function registerHandlers(bot: Bot): void {
  bot.use((ctx, next) => {
    if (WHITELIST.size === 0) return next();
    const id = ctx.from?.id;
    if (id !== undefined && WHITELIST.has(id)) return next();
    if (ctx.chat?.type === "private") return ctx.reply("⛔ Access denied. You are not whitelisted.");
    // in groups: silently ignore non-whitelisted users
  });
  bot.command("start", (ctx) => ctx.reply(HELP_TEXT));
  bot.command("help", (ctx) => ctx.reply(HELP_TEXT));
  bot.hears(SC_RE, (ctx) => handleSoundCloud(ctx));
  bot.hears(YT_RE, (ctx) => handleYouTube(ctx));
  bot.callbackQuery(/^all:(-?\d+:-?\d+)$/, (ctx) => handleDownloadAll(ctx, ctx.match[1]));
  bot.hears(SELECTION_RE, (ctx) => handleSelectionReply(ctx));
  bot.on("message:text", (ctx) => {
    if (ctx.chat.type === "private") {
      console.log(`No link matched: ${ctx.msg.text.slice(0, 200)}`);
      return ctx.reply("Send me a SoundCloud or YouTube link.");
    }
  });
  bot.catch((err) => {
    console.error(err.error);
    err.ctx.reply("❌ Unexpected error").catch(() => {});
  });
}

const WHITELIST = new Set(
  (process.env.WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number),
);

function reason(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

const AUTO_DELETE_MS = 15_000;

function deleteLater(ctx: Context, chatId: number, messageId: number): void {
  setTimeout(() => ctx.api.deleteMessage(chatId, messageId).catch(() => {}), AUTO_DELETE_MS);
}

async function editWait(ctx: Context, waitMsg: { message_id: number }, text: string): Promise<void> {
  if (!ctx.chat) return;
  await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, text).catch(() => {});
}

async function sendAudioSafe(
  ctx: Context,
  chatId: number,
  res: DownloadResult,
  thumb: Buffer | null,
): Promise<void> {
  const options = {
    title: res.title.slice(0, 64),
    performer: res.performer.slice(0, 64),
    duration: res.durationSec,
    ...(thumb ? { thumbnail: new InputFile(thumb, "thumb.jpg") } : {}),
  };
  try {
    await ctx.api.sendAudio(chatId, new InputFile(res.audio, res.filename), options);
  } catch {
    // thumbnail is sometimes >200 KB or not jpeg — retry without it
    const { thumbnail: _drop, ...withoutThumb } = options;
    await ctx.api.sendAudio(chatId, new InputFile(res.audio, res.filename), withoutThumb);
  }
}

async function sendTracks(
  ctx: Context,
  chatId: number,
  waitMsg: { message_id: number },
  label: string,
  fetchers: (() => Promise<DownloadResult>)[],
  total: number,
): Promise<void> {
  await editWait(ctx, waitMsg, `⏳ Playlist "${label}": ${total} tracks`);
  let sent = 0;
  for (const fetch of fetchers) {
    try {
      const res = await fetch();
      await sendAudioSafe(ctx, chatId, res, res.thumb);
      sent++;
    } catch (e) {
      console.error(`Track failed: ${reason(e)}`);
    }
  }
  const skipped = total - sent;
  await editWait(
    ctx,
    waitMsg,
    skipped > 0 ? `✅ Sent ${sent}/${total}, ${skipped} skipped` : `✅ Sent ${sent}/${total}`,
  );
  if (ctx.chat) deleteLater(ctx, ctx.chat.id, waitMsg.message_id);
}

function selectionKey(ctx: Context): string | undefined {
  if (!ctx.chat || !ctx.from) return undefined;
  return `${ctx.chat.id}:${ctx.from.id}`;
}

/** "1 3 5-9" -> sorted unique 1-based indices clamped to total. */
export function parseSelection(text: string, total: number): number[] {
  const out = new Set<number>();
  for (const tok of text.split(/[\s,]+/)) {
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    let a = parseInt(m[1], 10);
    let b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

async function offerSelection(
  ctx: Context,
  label: string,
  titles: string[],
  fetchers: (() => Promise<DownloadResult>)[],
): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  selections.set(key, { label, titles, fetchers });
  setTimeout(() => selections.delete(key), SELECTION_TTL_MS);

  const list = fetchers
    .slice(0, MAX_PLAYLIST_TRACKS)
    .map((_, i) => `${i + 1}. ${titles[i]}`)
    .join("\n");
  const keyboard = new InlineKeyboard().text(`⬇️ Download all (${fetchers.length})`, `all:${key}`);
  await ctx.reply(
    `Playlist "${label}" — ${fetchers.length} tracks.\n${list}\n\n` +
      `Reply with track numbers (e.g. 1 3 5-9), or tap the button to download all.`,
    { reply_markup: keyboard },
  );
}

async function handleDownloadAll(ctx: Context, key: string): Promise<void> {
  const pending = selections.get(key);
  await ctx.answerCallbackQuery();
  if (!pending || !ctx.chat || !ctx.callbackQuery?.message) {
    await ctx.reply("⏳ Selection expired — send the playlist link again.").catch(() => {});
    return;
  }
  const chatId = ctx.chat.id;
  const menuMsg = ctx.callbackQuery.message;
  await ctx.api.deleteMessage(chatId, menuMsg.message_id).catch(() => {});
  selections.delete(key);
  const waitMsg = await ctx.reply("⏳ Downloading…");
  await sendTracks(ctx, chatId, waitMsg, pending.label, pending.fetchers, pending.fetchers.length);
}

async function handleSelectionReply(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const pending = selections.get(key);
  if (!pending) {
    if (ctx.chat.type !== "private") return; // stay silent in groups
    const hint = await ctx.reply("Send me a SoundCloud or YouTube link.");
    deleteLater(ctx, ctx.chat.id, hint.message_id);
    return;
  }
  const indices = parseSelection(ctx.msg?.text ?? "", Math.min(pending.fetchers.length, MAX_PLAYLIST_TRACKS));
  if (indices.length === 0) {
    const hint = await ctx.reply("No valid track numbers. Example: 1 3 5-9");
    deleteLater(ctx, ctx.chat.id, hint.message_id);
    return;
  }
  selections.delete(key);
  const fetchers = indices.map((i) => pending.fetchers[i - 1]);
  const waitMsg = await ctx.reply(`⏳ Downloading ${fetchers.length} track(s)…`);
  await sendTracks(ctx, ctx.chat.id, waitMsg, pending.label, fetchers, fetchers.length);
}

async function handleSoundCloud(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.match) return;
  const chatId = ctx.chat.id;
  const rawUrl = ctx.match[0];
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const waitMsg = await ctx.reply("⏳ Downloading…");
  try {
    const entity = await resolve(url);
    if (entity.kind === "playlist") {
      await ctx.api.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      const tracks = entity.tracks.slice(0, MAX_PLAYLIST_TRACKS);
      await offerSelection(
        ctx,
        entity.title,
        tracks.map((t) => t.title),
        tracks.map((t) => () => downloadTrack(t)),
      );
    } else {
      const res = await downloadTrack(entity);
      await sendAudioSafe(ctx, chatId, res, res.thumb);
      await ctx.api.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    }
  } catch (e) {
    await editWait(ctx, waitMsg, `❌ ${reason(e)}`);
    if (ctx.chat) deleteLater(ctx, chatId, waitMsg.message_id);
  }
}

async function handleYouTube(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.match) return;
  const chatId = ctx.chat.id;
  const rawUrl = ctx.match[0];
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const waitMsg = await ctx.reply("⏳ Downloading…");
  try {
    if (/playlist\?/i.test(url)) {
      const { title, entries } = await listPlaylist(url);
      await ctx.api.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
      await offerSelection(
        ctx,
        title,
        entries.map((e) => e.title),
        entries.map((e) => () => downloadAudio(e.url)),
      );
    } else {
      const res = await downloadAudio(url);
      await sendAudioSafe(ctx, chatId, res, null);
      await ctx.api.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    }
  } catch (e) {
    await editWait(ctx, waitMsg, `❌ ${reason(e)}`);
    if (ctx.chat) deleteLater(ctx, chatId, waitMsg.message_id);
  }
}
