/** Drop a seat after this long without a table poll. The page polls every 3 seconds. */
export const PRESENCE_TTL_MS = 20_000;

type PresenceTable = {
  seats: { seen: number; beat: number }[];
};

/** A newer check wins. An older poll cannot mark someone present after they have left. */
export function notePresence(
  table: PresenceTable,
  seat: number,
  present: boolean,
  beat: number,
  now: number,
): void {
  const slot = table.seats[seat];
  if (!slot || !Number.isInteger(beat) || beat <= 0) return;
  if (slot.beat > beat) return;
  slot.beat = beat;
  slot.seen = present ? now : 0;
}

export function seatHere(seen: number | undefined, now: number): boolean {
  return typeof seen === "number" && seen > 0 && now - seen <= PRESENCE_TTL_MS;
}
