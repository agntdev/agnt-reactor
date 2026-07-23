/**
 * Injectable clock seam — every schedule, cutoff, "today", expiry, and
 * late/on-time decision goes through `now()` so tests can drive time.
 */

let _now: () => number = () => Date.now();

/** Current wall-clock time in epoch ms. */
export function now(): number {
  return _now();
}

/** Override the clock (tests). Pass `null` to restore the system clock. */
export function setNow(fn: (() => number) | null): void {
  _now = fn ?? (() => Date.now());
}

/** ISO-8601 timestamp for storage/display (internal; never dump raw to users). */
export function nowIso(): string {
  return new Date(now()).toISOString();
}
