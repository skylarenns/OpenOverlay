import { timingSafeEqual } from "node:crypto";

export function validStageKey(expected: string | null, provided: unknown): boolean {
  if (!expected || typeof provided !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(provided)) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
