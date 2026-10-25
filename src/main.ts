import { Bot } from "grammy";
import { registerHandlers } from "./bot.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is not set (see .env.example)");
  process.exit(1);
}

const bot = new Bot(token);
registerHandlers(bot);

try {
  await bot.init();
  console.log(`Bot @${bot.botInfo.username} started (long polling)`);
} catch (e) {
  console.error("Telegram API unreachable:", e);
  process.exit(1);
}

bot.start().catch((e) => {
  console.error(e);
  process.exit(1);
});
