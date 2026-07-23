import { inlineButton, inlineKeyboard, type InlineKeyboardMarkup } from "../toolkit/index.js";

export function backMenu(): InlineKeyboardMarkup {
  return inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);
}

export function cancelRow(): ReturnType<typeof inlineButton>[] {
  return [inlineButton("Cancel", "flow:cancel")];
}

export function withCancel(
  rows: ReturnType<typeof inlineButton>[][],
): InlineKeyboardMarkup {
  return inlineKeyboard([...rows, cancelRow()]);
}
