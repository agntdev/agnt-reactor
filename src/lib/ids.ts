import { now } from "./clock.js";

let seq = 0;

/** Short unique id for durable records (no crypto dependency). */
export function newId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${now().toString(36)}_${seq.toString(36)}`;
}
