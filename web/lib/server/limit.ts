/** Per-address request limits, kept in memory. One server process is assumed. */

export class RateLimitError extends Error {
  constructor() {
    super("Too many requests. Try again in a minute.");
    this.name = "RateLimitError";
  }
}

const WINDOW_MS = 60_000;
const MAX_KEYS = 20_000;
const hits = new Map<string, { start: number; count: number }>();

/**
 * The address comes from the proxy headers. Run the app behind a proxy that
 * sets x-forwarded-for itself, or every caller can pick their own address.
 */
export function callerOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "local";
}

export function limit(request: Request, bucket: string, max: number, now = Date.now()): void {
  if (!allow(`${bucket}:${callerOf(request)}`, max, now)) throw new RateLimitError();
}

export function allow(key: string, max: number, now: number): boolean {
  const entry = hits.get(key);
  if (!entry || now - entry.start >= WINDOW_MS) {
    if (hits.size >= MAX_KEYS) sweep(now);
    hits.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

function sweep(now: number): void {
  for (const [key, entry] of hits) {
    if (now - entry.start >= WINDOW_MS) hits.delete(key);
  }
  // Still full of live entries: drop the oldest ones so the map cannot grow without bound.
  if (hits.size >= MAX_KEYS) {
    let extra = hits.size - MAX_KEYS / 2;
    for (const key of hits.keys()) {
      if (extra <= 0) break;
      hits.delete(key);
      extra -= 1;
    }
  }
}
