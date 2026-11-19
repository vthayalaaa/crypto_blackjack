import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { argon2id } from "@noble/hashes/argon2.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isEthCluster, type Cluster } from "../table-view.ts";

export function newSolanaSeat(): { address: string; secret: string } {
  const key = Keypair.generate();
  return { address: key.publicKey.toBase58(), secret: Buffer.from(key.secretKey).toString("base64") };
}

export function newEthSeat(): { address: string; secret: string } {
  const secret = generatePrivateKey();
  return { address: privateKeyToAccount(secret).address, secret };
}

const V1 = "enc:v1:";
const V2 = "enc:v2:";
// Argon2id at the OWASP minimum: 19 MiB, 2 passes, 1 lane. The derived key is cached per salt.
const ARGON_M = 19_456;
const ARGON_T = 2;

function vaultKey(): Buffer | null {
  const value = process.env.SEAT_KEY_SECRET ?? "";
  if (!value) return null;
  if (value.length < 32) throw new Error("SEAT_KEY_SECRET has to be at least 32 characters.");
  return createHash("sha256").update(value).digest();
}

/** The password Argon2 stretches. ARGAON2_PASS is accepted so a misspelled env name still seals. */
export function argonPassword(): string {
  return process.env.ARGON2_PASS || process.env.ARGAON2_PASS || "";
}

function requirePassword(): string {
  const value = argonPassword();
  if (value.length < 32) throw new Error("ARGON2_PASS has to be at least 32 characters.");
  return value;
}

let cachedPassword = "";
const derivedKeys = new Map<string, Buffer>();

function argonKey(salt: Buffer): Buffer {
  const password = requirePassword();
  if (cachedPassword !== password) {
    derivedKeys.clear();
    cachedPassword = password;
  }
  const id = salt.toString("base64");
  const cached = derivedKeys.get(id);
  if (cached) return cached;
  const derived = Buffer.from(argon2id(new TextEncoder().encode(password), salt, {
    t: ARGON_T,
    m: ARGON_M,
    p: 1,
    dkLen: 32,
  }));
  derivedKeys.set(id, derived);
  return derived;
}

function canSeal(): boolean {
  return argonPassword().length >= 32 || vaultKey() !== null;
}

/** Real money needs the seat keys encrypted before they are stored. Test networks may run without it. */
function holdsRealMoney(cluster: Cluster): boolean {
  return cluster === "mainnet" || cluster === "ethereum";
}

/** A new seat for this network. The private key is encrypted when a password or SEAT_KEY_SECRET is set. */
export function newSeat(cluster: Cluster): { address: string; secret: string } {
  if (holdsRealMoney(cluster) && !canSeal()) {
    throw new Error("This server is not set up to hold mainnet buy-ins.");
  }
  const seat = isEthCluster(cluster) ? newEthSeat() : newSolanaSeat();
  return { address: seat.address, secret: sealSecret(seat.secret) };
}

export function sealSecret(secret: string): string {
  if (!secret || secret.startsWith(V1) || secret.startsWith(V2)) return secret;
  if (argonPassword()) return sealV2(secret);
  const key = vaultKey();
  if (!key) return secret;
  return sealV1(secret, key);
}

function sealV2(secret: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", argonKey(salt), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${V2}${salt.toString("base64")}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

function sealV1(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${V1}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

/** Seats stored before encryption was turned on are still readable. */
export function openSecret(stored: string): string {
  if (stored.startsWith(V2)) return openV2(stored);
  if (stored.startsWith(V1)) return openV1(stored);
  return stored;
}

function openV2(stored: string): string {
  const [salt, iv, tag, body] = stored.slice(V2.length).split(":");
  if (!salt || !iv || !tag || !body) throw new Error("The seat key could not be read.");
  const decipher = createDecipheriv("aes-256-gcm", argonKey(Buffer.from(salt, "base64")), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

function openV1(stored: string): string {
  const key = vaultKey();
  if (!key) throw new Error("The seat key is encrypted and SEAT_KEY_SECRET is not set.");
  const [iv, tag, body] = stored.slice(V1.length).split(":");
  if (!iv || !tag || !body) throw new Error("The seat key could not be read.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

export function sameWallet(cluster: Cluster, left: string, right: string): boolean {
  if (!left || !right) return false;
  return isEthCluster(cluster) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Keep the first wallet recorded for a seat. A later check from that same wallet may refresh it. */
export function rememberSeatWallet(cluster: Cluster, current: string, claimed: string): string {
  const next = claimed.trim();
  if (!next) return current;
  try {
    assertWallet(cluster, next);
  } catch {
    return current;
  }
  if (!current || sameWallet(cluster, current, next)) return next;
  return current;
}

export function assertWallet(cluster: Cluster, value: string): void {
  if (!value) throw new Error("Connect a wallet first.");
  if (isEthCluster(cluster)) {
    if (!isAddress(value)) throw new Error("That is not an Ethereum address.");
    return;
  }
  try {
    const key = new PublicKey(value);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error("off curve");
  } catch {
    throw new Error("That is not a Solana address.");
  }
}
