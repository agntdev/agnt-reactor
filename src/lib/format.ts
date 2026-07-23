/** Locale-stable number formatting for user-facing copy (always en-US). */
export function fmtNum(n: number): string {
  return Math.floor(n).toLocaleString("en-US");
}
