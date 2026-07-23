import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";

const composer = new Composer<Ctx>();

const WELCOME =
  "Reaction Manager — keep channel engagement on target.\n\n" +
  "Tap a button below to onboard, build a bot pool, set rules, or monitor jobs.";

composer.command("start", async (ctx) => {
  ctx.session.step = "idle";
  await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
});

composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  try {
    await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
  } catch {
    await ctx.reply(WELCOME, { reply_markup: mainMenuKeyboard() });
  }
});

composer.callbackQuery("flow:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "idle";
  ctx.session.draftChannelId = undefined;
  ctx.session.draftBotCount = undefined;
  ctx.session.draftBotId = undefined;
  ctx.session.draftTargetPct = undefined;
  ctx.session.draftSpreadMin = undefined;
  ctx.session.draftTemplates = undefined;
  try {
    await ctx.editMessageText("Cancelled. Tap a menu button when you're ready.", {
      reply_markup: mainMenuKeyboard(),
    });
  } catch {
    await ctx.reply("Cancelled. Tap a menu button when you're ready.", {
      reply_markup: mainMenuKeyboard(),
    });
  }
});

export default composer;
