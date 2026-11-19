import { randomInt } from "node:crypto";
import { handTotal } from "../cards.ts";
import { MAX_SEATS, MIN_SEATS, type Cluster, type Phase, type Seat, type SeatView, type TableView } from "../table-view.ts";

const TURN_MS = 600_000;
const MAX_HITS = 6;
const WAIT_MS = 900_000;
const BUYIN_MS = 300_000;

export type SeatState = {
  address: string;
  secret: string;
  wallet: string;
  funded: boolean;
  cards: number[];
  hits: number;
  seen: number;
  beat: number;
  out: boolean;
  /** Voted to start the hand with the players who have already sat. */
  ready: boolean;
};

export type SecretTable = {
  id: string;
  cluster: Cluster;
  stake: string;
  due: string;
  buffer: string;
  phase: Phase;
  turn: number;
  winners: number[];
  invite: string;
  seats: SeatState[];
  fundSignatures: string[];
  deck: number[];
  deadline: number;
  payouts: string[];
  payoutError: string;
  paid: Record<string, boolean>;
  /** Signed payout transfers, saved before each one is broadcast. Keyed by leg id. */
  sends: Record<string, PayoutSend>;
  createdAt: number;
  /** Paid seats that voted to remove an unpaid seat. Keyed by the target seat. */
  kickVotes: Record<string, number[]>;
};

/**
 * Enough to find a payout on-chain and to broadcast the same bytes again.
 * Solana: `expires` is the last block height the transfer can land in.
 * Ethereum: `nonce` is the seat nonce the transfer uses.
 */
export type PayoutSend = {
  signature: string;
  raw: string;
  from: string;
  expires: number;
  nonce: number;
  at: number;
};

export function shuffleDeck(): number[] {
  const deck = Array.from({ length: 52 }, (_, index) => index);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const swap = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = swap;
  }
  return deck;
}

export function blankSeat(): SeatState {
  return { address: "", secret: "", wallet: "", funded: false, cards: [], hits: 0, seen: 0, beat: 0, out: false, ready: false };
}

export function blankTable(input: {
  id: string;
  cluster: Cluster;
  stake: bigint;
  due: bigint;
  buffer: bigint;
  invite: string;
  capacity?: number;
  playerSeat: string;
  playerSecret: string;
  deck?: number[];
}): SecretTable {
  const capacity = input.capacity ?? MIN_SEATS;
  if (!Number.isInteger(capacity) || capacity < MIN_SEATS || capacity > MAX_SEATS) {
    throw new Error("A table seats 2 to 7 players.");
  }
  const seats = Array.from({ length: capacity }, () => blankSeat());
  seats[0] = { ...blankSeat(), address: input.playerSeat, secret: input.playerSecret };
  return {
    id: input.id,
    cluster: input.cluster,
    stake: input.stake.toString(),
    due: input.due.toString(),
    buffer: input.buffer.toString(),
    phase: "waiting",
    turn: -1,
    winners: [],
    invite: input.invite,
    seats,
    fundSignatures: [],
    deck: input.deck ?? shuffleDeck(),
    deadline: 0,
    payouts: [],
    payoutError: "",
    paid: {},
    sends: {},
    createdAt: Date.now(),
    kickVotes: {},
  };
}

/**
 * The first buy-in starts a clock. If the table has not filled and funded by then,
 * any funded seat can cancel and take its buy-in back.
 */
export function startRefundClock(table: SecretTable, now: number): void {
  if (table.phase !== "waiting" || table.deadline !== 0) return;
  table.deadline = Math.floor(now / 1000) + WAIT_MS / 1000;
}

/**
 * A seated player votes to begin with whoever is already here.
 * When every seated player has voted, the empty seats close.
 * Paid seats are dealt. Otherwise the five-minute buy-in clock starts.
 */
export function voteStart(table: SecretTable, seat: Seat, now: number): void {
  if (table.phase !== "waiting") throw new Error("The hand has already started.");
  if (typeof seat !== "number" || !table.seats[seat]?.address) throw new Error("Sit down before voting to start.");
  const seated = table.seats.filter((slot) => slot.address).length;
  if (seated < MIN_SEATS) throw new Error("Two players have to sit before the table can start.");
  if (seated === table.seats.length) throw new Error("Every seat is already taken.");
  const slot = table.seats[seat]!;
  slot.ready = !slot.ready;
  if (table.seats.some((item) => item.address && !item.ready)) return;
  const last = table.seats.reduce((end, item, index) => (item.address ? index : end), -1);
  if (table.seats.slice(0, last + 1).some((item) => !item.address)) {
    slot.ready = !slot.ready;
    throw new Error("The table cannot start while a middle seat is open.");
  }
  table.seats = table.seats.slice(0, last + 1);
  for (const item of table.seats) item.ready = false;
  if (table.seats.every((item) => item.funded)) {
    openHand(table, now);
    return;
  }
  startBuyInClock(table, now);
}

/** Paid players needed before a kick vote can remove someone. */
export function kickNeeded(paid: number): number {
  return Math.floor(paid / 2) + 1;
}

/**
 * A paid player votes to remove an unpaid player.
 * The seat opens when a majority of the paid players have voted.
 */
export function voteKick(table: SecretTable, voter: number, target: number): { kicked: boolean; votes: number; needed: number } {
  if (table.phase !== "waiting") throw new Error("That player can only be kicked before the deal.");
  if (table.seats.length < 3) throw new Error("A two-player table cannot kick a player.");
  const paid = table.seats.filter((seat) => seat.address && seat.funded).length;
  if (paid <= 2) throw new Error("More than two paid players are needed to kick.");
  const voterSeat = table.seats[voter];
  if (!voterSeat?.address || !voterSeat.funded) throw new Error("Buy in before you vote to kick.");
  if (voter === target) throw new Error("You cannot kick yourself.");
  const victim = table.seats[target];
  if (!victim?.address) throw new Error("Nobody at the table has that name.");
  if (victim.funded) throw new Error("That player has already bought in.");
  const key = String(target);
  for (const other of Object.keys(table.kickVotes)) {
    table.kickVotes[other] = (table.kickVotes[other] ?? []).filter((seat) => seat !== voter);
    if (table.kickVotes[other]!.length === 0) delete table.kickVotes[other];
  }
  const votes = [...new Set([...(table.kickVotes[key] ?? []), voter])].filter((seat) => {
    const slot = table.seats[seat];
    return Boolean(slot?.address && slot.funded);
  });
  table.kickVotes[key] = votes;
  const needed = kickNeeded(paid);
  if (votes.length < needed) return { kicked: false, votes: votes.length, needed };
  table.seats[target] = blankSeat();
  delete table.kickVotes[key];
  for (const other of Object.keys(table.kickVotes)) {
    table.kickVotes[other] = (table.kickVotes[other] ?? []).filter((seat) => seat !== target);
    if (table.kickVotes[other]!.length === 0) delete table.kickVotes[other];
  }
  return { kicked: true, votes: votes.length, needed };
}

/** The last empty seat starts five minutes for the remaining buy-ins. */
export function startBuyInClock(table: SecretTable, now: number): void {
  if (table.phase !== "waiting") return;
  if (table.seats.some((seat) => !seat.address)) return;
  table.deadline = Math.floor(now / 1000) + BUYIN_MS / 1000;
}

export function takeSeat(
  table: SecretTable,
  index: number,
  seat: { address: string; secret: string; wallet: string },
): void {
  const slot = table.seats[index];
  if (!slot || slot.address) throw new Error("Someone already took that seat.");
  slot.address = seat.address;
  slot.secret = seat.secret;
  slot.wallet = seat.wallet;
}

/** Read older two-seat tables into the current seat list. */
export function normalizeTable(raw: unknown): SecretTable {
  const table = raw as LegacyTable;
  if (Array.isArray(table.seats) && table.seats.length >= MIN_SEATS) {
    return finishNormalized(table, table.seats.map(normalizeSeat));
  }
  const first = blankSeat();
  first.address = table.playerSeat ?? "";
  first.secret = table.playerSecret ?? "";
  first.wallet = table.playerWallet ?? "";
  first.funded = Boolean(table.playerFunded);
  first.cards = Array.isArray(table.playerCards) ? table.playerCards : [];
  first.hits = table.hits ?? 0;
  first.seen = table.playerSeen ?? 0;
  first.beat = table.playerBeat ?? 0;
  const second = blankSeat();
  second.address = table.dealerSeat ?? "";
  second.secret = table.dealerSecret ?? "";
  second.wallet = table.dealerWallet ?? "";
  second.funded = Boolean(table.dealerFunded);
  second.cards = Array.isArray(table.dealerCards) ? table.dealerCards : [];
  second.hits = table.secondHits ?? 0;
  second.seen = table.dealerSeen ?? 0;
  second.beat = table.dealerBeat ?? 0;
  return finishNormalized(table, [first, second]);
}

export function normalizeStoredSeat(seat: unknown): number | "spectator" {
  if (seat === "player") return 0;
  if (seat === "dealer") return 1;
  if (typeof seat === "number" && Number.isInteger(seat) && seat >= 0 && seat < MAX_SEATS) return seat;
  return "spectator";
}

export function openHand(table: SecretTable, now: number): void {
  if (table.phase !== "waiting") throw new Error("This hand has already started.");
  if (!table.seats.every((seat) => seat.address && seat.funded)) throw new Error("Every seat has to buy in first.");
  for (let round = 0; round < 2; round += 1) {
    for (const seat of table.seats) seat.cards.push(draw(table));
  }
  beginTurn(table, firstActor(table), now);
}

export function hit(table: SecretTable, seat: Seat, now: number): void {
  const index = requireTurn(table, seat);
  const cards = table.seats[index]!.cards;
  const used = table.seats[index]!.hits;
  if (used >= MAX_HITS) throw new Error("No cards left for this hand.");
  if (handTotal(cards) >= 21) throw new Error("This hand is already finished.");
  cards.push(draw(table));
  table.seats[index]!.hits = used + 1;
  if (handTotal(cards) >= 21 || table.seats[index]!.hits >= MAX_HITS) {
    finishSeat(table, index, now);
    return;
  }
  table.deadline = deadlineAt(now);
}

export function stand(table: SecretTable, seat: Seat, now = Date.now()): void {
  finishSeat(table, requireTurn(table, seat), now);
}

export function cancel(table: SecretTable, seat: Seat, now = Date.now()): void {
  if (table.phase !== "waiting") throw new Error("The hand has already started.");
  if (seat !== 0) {
    const funded = typeof seat === "number" && Boolean(table.seats[seat]?.funded);
    const expired = table.deadline !== 0 && now >= table.deadline * 1000;
    if (!funded || !expired) throw new Error("Only the first player can cancel until the wait runs out.");
  }
  table.phase = "cancelled";
  table.turn = -1;
  table.deadline = 0;
}

export function claim(table: SecretTable, seat: Seat, now: number): void {
  if (table.phase !== "acting" || typeof seat !== "number" || seat === table.turn || !table.seats[seat]?.address) {
    throw new Error("Only another player can claim a stalled hand.");
  }
  if (table.deadline === 0 || now < table.deadline * 1000) throw new Error("The acting player still has time.");
  table.seats[table.turn]!.out = true;
  const remaining = table.seats.filter((slot) => slot.address && !slot.out);
  // The last seat in still has to beat the rules: settle never lets a bust win.
  if (remaining.length === 1) {
    settle(table);
    return;
  }
  beginTurn(table, nextActor(table, table.turn), now);
}

export function toView(table: SecretTable, yourSeat: Seat): TableView {
  const reveal = table.phase === "settled" || table.phase === "cancelled";
  const yours = typeof yourSeat === "number" ? table.seats[yourSeat] : undefined;
  const funded = table.seats.filter((seat) => seat.funded).length;
  const playing = table.seats.filter((seat) => seat.address).length;
  const pot = (BigInt(table.stake) * BigInt(table.phase === "waiting" || table.phase === "cancelled" ? funded : playing)).toString();
  const actor = table.phase === "acting" ? table.seats[table.turn] : undefined;
  return {
    id: table.id,
    cluster: table.cluster,
    stake: table.stake,
    due: table.due,
    buffer: table.buffer,
    pot,
    phase: table.phase,
    turn: table.turn,
    winners: [...table.winners],
    yourSeat,
    seats: table.seats.map((seat, index) => seatView(seat, index, reveal || yourSeat === index)),
    invite: table.invite,
    hitsLeft: actor ? Math.max(0, MAX_HITS - actor.hits) : 0,
    deadline: table.deadline,
    payouts: [...table.payouts],
    payoutError: table.payoutError,
    depositAddress: yours && !yours.funded ? yours.address : "",
  };
}

function seatView(seat: SeatState, index: number, show: boolean): SeatView {
  return {
    index,
    address: seat.address,
    wallet: seat.wallet,
    funded: seat.funded,
    cards: show ? [...seat.cards] : [],
    faceDown: show || !seat.address ? 0 : Math.max(seat.cards.length, 2),
    out: seat.out,
    ready: seat.ready,
  };
}

function requireTurn(table: SecretTable, seat: Seat): number {
  if (table.phase !== "acting" || seat !== table.turn) throw new Error("It is not your turn.");
  return table.turn;
}

function finishSeat(table: SecretTable, index: number, now: number): void {
  beginTurn(table, nextActor(table, index), now);
}

function beginTurn(table: SecretTable, index: number, now: number): void {
  if (index < 0) {
    settle(table);
    return;
  }
  table.phase = "acting";
  table.turn = index;
  table.deadline = deadlineAt(now);
}

function settle(table: SecretTable): void {
  const active = table.seats.flatMap((seat, index) => (seat.address && !seat.out ? [index] : []));
  const standing = active.filter((index) => handTotal(table.seats[index]!.cards) <= 21);
  if (standing.length > 0) {
    const best = Math.max(...standing.map((index) => handTotal(table.seats[index]!.cards)));
    const tied = standing.filter((index) => handTotal(table.seats[index]!.cards) === best);
    const forfeited = table.seats.some((seat) => seat.address && seat.out);
    table.winners = !forfeited && tied.length === active.length ? [] : tied;
  } else {
    // Every hand still in is over 21. A bust never wins, even against a seat that
    // timed out, so every buy-in goes back.
    table.winners = [];
  }
  table.phase = "settled";
  table.turn = -1;
  table.deadline = 0;
}

function firstActor(table: SecretTable): number {
  return table.seats.findIndex(needsDecision);
}

function nextActor(table: SecretTable, from: number): number {
  for (let index = from + 1; index < table.seats.length; index += 1) {
    if (needsDecision(table.seats[index]!)) return index;
  }
  return -1;
}

function needsDecision(seat: SeatState): boolean {
  return Boolean(seat.address) && !seat.out && seat.cards.length > 0 && handTotal(seat.cards) < 21 && seat.hits < MAX_HITS;
}

function deadlineAt(now: number): number {
  return Math.floor(now / 1000) + TURN_MS / 1000;
}

function draw(table: SecretTable): number {
  const card = table.deck.pop();
  if (card === undefined) throw new Error("The shoe is empty.");
  return card;
}

type LegacyTable = Partial<SecretTable> & {
  outcome?: number;
  playerSeat?: string;
  dealerSeat?: string;
  playerSecret?: string;
  dealerSecret?: string;
  playerWallet?: string;
  dealerWallet?: string;
  playerFunded?: boolean;
  dealerFunded?: boolean;
  playerCards?: number[];
  dealerCards?: number[];
  hits?: number;
  secondHits?: number;
  playerSeen?: number;
  dealerSeen?: number;
  playerBeat?: number;
  dealerBeat?: number;
  phase?: string;
  paid?: Record<string, boolean> & { player?: boolean; dealer?: boolean };
};

function normalizeSeat(raw: Partial<SeatState> | undefined): SeatState {
  const seat = blankSeat();
  if (!raw) return seat;
  seat.address = raw.address ?? "";
  seat.secret = raw.secret ?? "";
  seat.wallet = raw.wallet ?? "";
  seat.funded = Boolean(raw.funded);
  seat.cards = Array.isArray(raw.cards) ? raw.cards : [];
  seat.hits = raw.hits ?? 0;
  seat.seen = raw.seen ?? 0;
  seat.beat = raw.beat ?? 0;
  seat.out = Boolean(raw.out);
  seat.ready = Boolean(raw.ready);
  return seat;
}

function finishNormalized(table: LegacyTable, seats: SeatState[]): SecretTable {
  const storedPhase = String(table.phase ?? "");
  const phase = normalizePhase(storedPhase);
  const turn = phase === "acting"
    ? (typeof table.turn === "number" && table.turn >= 0 ? table.turn : storedPhase === "second" ? 1 : 0)
    : -1;
  return {
    id: table.id ?? "",
    cluster: table.cluster ?? "devnet",
    stake: table.stake ?? "0",
    due: table.due ?? "0",
    buffer: table.buffer ?? "0",
    phase,
    turn,
    winners: normalizeWinners(table, seats.length),
    invite: table.invite ?? "",
    seats,
    fundSignatures: Array.isArray(table.fundSignatures) ? table.fundSignatures : [],
    deck: Array.isArray(table.deck) ? table.deck : [],
    deadline: table.deadline ?? 0,
    payouts: Array.isArray(table.payouts) ? table.payouts : [],
    payoutError: table.payoutError ?? "",
    paid: normalizePaid(table.paid),
    sends: table.sends && typeof table.sends === "object" ? table.sends : {},
    createdAt: typeof table.createdAt === "number" ? table.createdAt : 0,
    kickVotes: normalizeKickVotes(table.kickVotes),
  };
}

function normalizeKickVotes(raw: unknown): Record<string, number[]> {
  if (!raw || typeof raw !== "object") return {};
  const votes: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(key) || !Array.isArray(value)) continue;
    const seats = value.filter((item) => Number.isInteger(item) && item >= 0 && item < MAX_SEATS);
    if (seats.length > 0) votes[key] = seats;
  }
  return votes;
}

function normalizePhase(phase: string | undefined): Phase {
  if (phase === "settled" || phase === "cancelled" || phase === "waiting" || phase === "acting") return phase;
  if (phase === "player" || phase === "second") return "acting";
  return "waiting";
}

function normalizeWinners(table: LegacyTable, count: number): number[] {
  if (Array.isArray(table.winners)) return table.winners.filter((index) => Number.isInteger(index) && index >= 0 && index < count);
  if (table.outcome === 1) return [0];
  if (table.outcome === 2) return [1];
  return [];
}

function normalizePaid(paid: LegacyTable["paid"]): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  if (!paid) return next;
  for (const [key, value] of Object.entries(paid)) {
    if (value) next[key === "player" ? "0" : key === "dealer" ? "1" : key] = true;
  }
  return next;
}
