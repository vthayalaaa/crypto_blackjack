/** Drop a seat after this long without a table poll. The page polls every 3 seconds. */
export const PRESENCE_TTL_MS = 20_000;

type PresenceTable = {
  playerSeen?: number;
  dealerSeen?: number;
  playerBeat?: number;
  dealerBeat?: number;
};

/** A newer check wins. An older poll cannot mark someone present after they have left. */
export function notePresence(
  table: PresenceTable,
  seat: "player" | "dealer",
  present: boolean,
  beat: number,
  now: number,
): void {
  if (!Number.isInteger(beat) || beat <= 0) return;
  const seenKey = seat === "player" ? "playerSeen" : "dealerSeen";
  const beatKey = seat === "player" ? "playerBeat" : "dealerBeat";
  if ((table[beatKey] ?? 0) > beat) return;
  table[beatKey] = beat;
  table[seenKey] = present ? now : 0;
}

export function seatHere(seen: number | undefined, now: number): boolean {
  return typeof seen === "number" && seen > 0 && now - seen <= PRESENCE_TTL_MS;
}
