import { Buffer } from "buffer";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { OFF } from "./layout";

export const PROGRAM_ID = new PublicKey("GtkZUSisZjxGFNamJTEEZNCndUaJX9sMSm6tTgu9yAsv");
export const MIN_STAKE = 10_000_000n;
export const MAX_STAKE = 50_000_000_000n;
export const CARD_SLOTS = 16;

const DISC = 8;

export type GameAccount = {
  player: PublicKey;
  dealer: PublicKey;
  invite: PublicKey;
  stake: bigint;
  gameId: bigint;
  status: number;
  outcome: number;
  playerCards: number[];
  dealerCards: number[];
  nextPlayerHit: number;
  deadline: bigint;
  createdAt: bigint;
};

export function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function randomGameId(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = new DataView(bytes.buffer).getBigUint64(0, true);
  if (id === 0n) id = 1n;
  return id;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function discriminator(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

export async function accountDiscriminator(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("account:Game"));
  return new Uint8Array(digest).slice(0, 8);
}

export function findGame(player: PublicKey, gameId: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("game"), player.toBytes(), u64(gameId)],
    PROGRAM_ID,
  )[0];
}

export function findVault(game: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault"), game.toBytes()],
    PROGRAM_ID,
  )[0];
}

export function isEmptyKey(key: PublicKey): boolean {
  return key.equals(PublicKey.default);
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").slice(0, 4).replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : `${whole.toString()}`;
}

export function shortKey(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function decodeGame(data: Uint8Array, disc: Uint8Array): GameAccount {
  if (data.length < DISC + OFF.end) {
    throw new Error("Table account is the wrong size.");
  }
  for (let i = 0; i < disc.length; i += 1) {
    if (data[i] !== disc[i]) throw new Error("This account is not a blackjack table.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const keyAt = (offset: number) => new PublicKey(data.subarray(DISC + offset, DISC + offset + 32));
  const playerLen = data[DISC + OFF.playerLen] ?? 0;
  const dealerLen = data[DISC + OFF.dealerLen] ?? 0;
  return {
    player: keyAt(OFF.player),
    dealer: keyAt(OFF.dealer),
    invite: keyAt(OFF.invite),
    stake: view.getBigUint64(DISC + OFF.stake, true),
    gameId: view.getBigUint64(DISC + OFF.gameId, true),
    status: data[DISC + OFF.status] ?? 0,
    outcome: data[DISC + OFF.outcome] ?? 0,
    playerCards: Array.from(data.subarray(DISC + OFF.playerCards, DISC + OFF.playerCards + playerLen)),
    dealerCards: Array.from(data.subarray(DISC + OFF.dealerCards, DISC + OFF.dealerCards + dealerLen)),
    nextPlayerHit: data[DISC + OFF.nextPlayerHit] ?? 0,
    deadline: view.getBigInt64(DISC + OFF.deadline, true),
    createdAt: view.getBigInt64(DISC + OFF.createdAt, true),
  };
}

function ix(programKeys: AccountMeta[], data: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: programKeys,
    data: Buffer.from(data),
  });
}

function tableMetas(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey, signer: "player" | "dealer"): AccountMeta[] {
  return [
    { pubkey: player, isSigner: signer === "player", isWritable: true },
    { pubkey: dealer, isSigner: signer === "dealer", isWritable: true },
    { pubkey: game, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

function moneyMetas(payer: PublicKey, game: PublicKey, vault: PublicKey): AccountMeta[] {
  return [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: game, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

export async function createGameIx(args: {
  player: PublicKey;
  game: PublicKey;
  vault: PublicKey;
  gameId: bigint;
  stake: bigint;
  invite: PublicKey;
  commits: Uint8Array;
}): Promise<TransactionInstruction> {
  const data = concat([
    await discriminator("create_game"),
    u64(args.gameId),
    u64(args.stake),
    args.invite.toBytes(),
    args.commits,
  ]);
  return ix(moneyMetas(args.player, args.game, args.vault), data);
}

export async function joinGameIx(args: {
  dealer: PublicKey;
  game: PublicKey;
  vault: PublicKey;
  commits: Uint8Array;
}): Promise<TransactionInstruction> {
  const data = concat([await discriminator("join_game"), args.commits]);
  return ix(moneyMetas(args.dealer, args.game, args.vault), data);
}

export async function cancelGameIx(args: {
  player: PublicKey;
  game: PublicKey;
  vault: PublicKey;
}): Promise<TransactionInstruction> {
  return ix(moneyMetas(args.player, args.game, args.vault), await discriminator("cancel_game"));
}

export async function closeTableIx(args: {
  player: PublicKey;
  game: PublicKey;
  vault: PublicKey;
}): Promise<TransactionInstruction> {
  return ix(moneyMetas(args.player, args.game, args.vault), await discriminator("close_table"));
}

export async function claimTimeoutIx(args: {
  claimant: PublicKey;
  game: PublicKey;
  vault: PublicKey;
}): Promise<TransactionInstruction> {
  return ix(moneyMetas(args.claimant, args.game, args.vault), await discriminator("claim_timeout"));
}

async function moveIx(
  name: string,
  signer: "player" | "dealer",
  player: PublicKey,
  dealer: PublicKey,
  game: PublicKey,
  vault: PublicKey,
  body?: Uint8Array,
): Promise<TransactionInstruction> {
  const data = body
    ? concat([await discriminator(name), body])
    : await discriminator(name);
  return ix(tableMetas(player, dealer, game, vault, signer), data);
}

export function openingSeeds(seeds: Uint8Array[]): Uint8Array {
  return concat(seeds.slice(0, 3));
}

export function showdownSeeds(seeds: Uint8Array[]): Uint8Array {
  return concat([seeds[3]!, ...seeds.slice(10, 16)]);
}

export async function dealerOpeningIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey, seeds: Uint8Array[]): Promise<TransactionInstruction> {
  return moveIx("dealer_reveal_opening", "dealer", player, dealer, game, vault, openingSeeds(seeds));
}

export async function playerOpeningIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey, seeds: Uint8Array[]): Promise<TransactionInstruction> {
  return moveIx("player_reveal_opening", "player", player, dealer, game, vault, openingSeeds(seeds));
}

export async function hitIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey): Promise<TransactionInstruction> {
  return moveIx("hit", "player", player, dealer, game, vault);
}

export async function standIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey): Promise<TransactionInstruction> {
  return moveIx("stand", "player", player, dealer, game, vault);
}

export async function dealerHitIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey, seed: Uint8Array): Promise<TransactionInstruction> {
  return moveIx("dealer_reveal_hit", "dealer", player, dealer, game, vault, seed);
}

export async function playerHitIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey, seed: Uint8Array): Promise<TransactionInstruction> {
  return moveIx("player_reveal_hit", "player", player, dealer, game, vault, seed);
}

export async function dealerShowdownIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey, seeds: Uint8Array[]): Promise<TransactionInstruction> {
  return moveIx("dealer_reveal_showdown", "dealer", player, dealer, game, vault, showdownSeeds(seeds));
}

export async function playerShowdownIx(player: PublicKey, dealer: PublicKey, game: PublicKey, vault: PublicKey, seeds: Uint8Array[]): Promise<TransactionInstruction> {
  return moveIx("player_reveal_showdown", "player", player, dealer, game, vault, showdownSeeds(seeds));
}
