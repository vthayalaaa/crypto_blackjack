import { randomInt } from "node:crypto";
import { handTotal } from "../cards.ts";
import type { Cluster, Phase, Seat, TableView } from "../table-view.ts";

const TURN_MS = 600_000;
const MAX_HITS = 6;

export type SecretTable = {
  id: string;
  cluster: Cluster;
  stake: string;
  due: string;
  buffer: string;
  phase: Phase;
  outcome: 0 | 1 | 2 | 3;
  invite: string;
  playerSeat: string;
  dealerSeat: string;
  playerSecret: string;
  dealerSecret: string;
  playerWallet: string;
  dealerWallet: string;
  playerFunded: boolean;
  dealerFunded: boolean;
  fundSignatures: string[];
  deck: number[];
  playerCards: number[];
  dealerCards: number[];
  hits: number;
  secondHits: number;
  deadline: number;
  payouts: string[];
  payoutError: string;
  paid: { player: boolean; dealer: boolean };
  paying: boolean;
  playerSeen: number;
  dealerSeen: number;
  playerBeat: number;
  dealerBeat: number;
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

export function blankTable(input: {
  id: string;
  cluster: Cluster;
  stake: bigint;
  due: bigint;
  buffer: bigint;
  invite: string;
  playerSeat: string;
  playerSecret: string;
  deck?: number[];
}): SecretTable {
  return {
    id: input.id,
    cluster: input.cluster,
    stake: input.stake.toString(),
    due: input.due.toString(),
    buffer: input.buffer.toString(),
    phase: "waiting",
    outcome: 0,
    invite: input.invite,
    playerSeat: input.playerSeat,
    dealerSeat: "",
    playerSecret: input.playerSecret,
    dealerSecret: "",
    playerWallet: "",
    dealerWallet: "",
    playerFunded: false,
    dealerFunded: false,
    fundSignatures: [],
    deck: input.deck ?? shuffleDeck(),
    playerCards: [],
    dealerCards: [],
    hits: 0,
    secondHits: 0,
    deadline: 0,
    payouts: [],
    payoutError: "",
    paid: { player: false, dealer: false },
    paying: false,
    playerSeen: 0,
    dealerSeen: 0,
    playerBeat: 0,
    dealerBeat: 0,
  };
}

export function openHand(table: SecretTable, now: number): void {
  if (table.phase !== "waiting") throw new Error("This hand has already started.");
  table.playerCards = [draw(table), draw(table)];
  table.dealerCards = [draw(table), draw(table)];
  if (handTotal(table.playerCards) >= 21) {
    beginSecond(table, now);
    return;
  }
  table.phase = "player";
  table.deadline = deadlineAt(now);
}

export function hit(table: SecretTable, seat: Seat, now: number): void {
  requireTurn(table, seat);
  const cards = handOf(table, seat);
  const used = hitCount(table, seat);
  if (used >= MAX_HITS) throw new Error("No cards left for this hand.");
  if (handTotal(cards) >= 21) throw new Error("This hand is already finished.");
  cards.push(draw(table));
  setHitCount(table, seat, used + 1);
  const total = handTotal(cards);
  if (total >= 21 || hitCount(table, seat) >= MAX_HITS) {
    finishSeat(table, seat, now);
    return;
  }
  table.deadline = deadlineAt(now);
}

export function stand(table: SecretTable, seat: Seat, now = Date.now()): void {
  requireTurn(table, seat);
  finishSeat(table, seat, now);
}

export function cancel(table: SecretTable, seat: Seat): void {
  if (seat !== "player") throw new Error("Only the player can cancel.");
  if (table.phase !== "waiting") throw new Error("The hand has already started.");
  table.phase = "cancelled";
  table.deadline = 0;
}

export function claim(table: SecretTable, seat: Seat, now: number): void {
  const waiting = table.phase === "player" ? "dealer" : table.phase === "second" ? "player" : "";
  if (!waiting || seat !== waiting) throw new Error("Only the other player can claim a stalled hand.");
  if (table.deadline === 0 || now < table.deadline * 1000) throw new Error("The other player still has time.");
  table.outcome = table.phase === "player" ? 2 : 1;
  table.phase = "settled";
  table.deadline = 0;
}

export function toView(table: SecretTable, yourSeat: Seat): TableView {
  const reveal = table.phase === "settled" || table.phase === "cancelled";
  const showPlayer = reveal || yourSeat === "player";
  const showSecond = reveal || yourSeat === "dealer";
  const funded = Number(table.playerFunded) + Number(table.dealerFunded);
  const pot = (BigInt(table.stake) * BigInt(table.phase === "waiting" || table.phase === "cancelled" ? funded : 2)).toString();
  const depositAddress = yourSeat === "player" && !table.playerFunded
    ? table.playerSeat
    : yourSeat === "dealer" && !table.dealerFunded
      ? table.dealerSeat
      : "";
  const actorHits = table.phase === "second" ? hitCount(table, "dealer") : hitCount(table, "player");
  return {
    id: table.id,
    cluster: table.cluster,
    stake: table.stake,
    due: table.due,
    buffer: table.buffer,
    pot,
    phase: table.phase,
    outcome: table.outcome,
    yourSeat,
    playerSeat: table.playerSeat,
    dealerSeat: table.dealerSeat,
    playerWallet: table.playerWallet,
    dealerWallet: table.dealerWallet,
    playerFunded: table.playerFunded,
    dealerFunded: table.dealerFunded,
    invite: table.invite,
    playerCards: showPlayer ? [...table.playerCards] : [],
    dealerCards: showSecond ? [...table.dealerCards] : [],
    playerFaceDown: showPlayer ? 0 : table.playerCards.length,
    dealerFaceDown: showSecond ? 0 : table.dealerCards.length,
    hitsLeft: Math.max(0, MAX_HITS - actorHits),
    deadline: table.deadline,
    payouts: [...table.payouts],
    payoutError: table.payoutError,
    depositAddress,
  };
}

function requireTurn(table: SecretTable, seat: Seat): void {
  const turn = table.phase === "player" ? "player" : table.phase === "second" ? "dealer" : "";
  if (seat !== turn) throw new Error("It is not your turn.");
}

function finishSeat(table: SecretTable, seat: Seat, now: number): void {
  if (seat === "player") {
    beginSecond(table, now);
    return;
  }
  settle(table);
}

function beginSecond(table: SecretTable, now: number): void {
  if (handTotal(table.dealerCards) >= 21) {
    settle(table);
    return;
  }
  table.phase = "second";
  table.deadline = deadlineAt(now);
}

function settle(table: SecretTable): void {
  const first = handTotal(table.playerCards);
  const second = handTotal(table.dealerCards);
  table.outcome = first > 21 && second > 21 ? 3
    : first > 21 ? 2
    : second > 21 ? 1
    : first > second ? 1
    : second > first ? 2
    : 3;
  table.phase = "settled";
  table.deadline = 0;
}

function handOf(table: SecretTable, seat: Seat): number[] {
  return seat === "dealer" ? table.dealerCards : table.playerCards;
}

function hitCount(table: SecretTable, seat: Seat): number {
  return seat === "dealer" ? (table.secondHits ?? 0) : table.hits;
}

function setHitCount(table: SecretTable, seat: Seat, count: number): void {
  if (seat === "dealer") table.secondHits = count;
  else table.hits = count;
}

function deadlineAt(now: number): number {
  return Math.floor(now / 1000) + TURN_MS / 1000;
}

function draw(table: SecretTable): number {
  const card = table.deck.pop();
  if (card === undefined) throw new Error("The shoe is empty.");
  return card;
}
