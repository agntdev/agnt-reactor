import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const HELP =
  "Reaction Manager keeps engagement on your channels without the busywork.\n\n" +
  "• Onboard Account — connect yourself and link a channel\n" +
  "• Create Bot Pool — register bots for a channel (free tier: 10)\n" +
  "• Configure Rules — target %, timing, reply templates\n" +
  "• Monitor Jobs — status, filters, recent activity\n\n" +
  "Tap /start for the menu. Everything is reachable by buttons.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu });
});

export default composer;
