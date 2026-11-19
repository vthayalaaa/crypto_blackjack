import fs from "node:fs";
import path from "node:path";
import { isEthCluster, type Cluster } from "../table-view.ts";
import { SanctionedWalletError } from "./sanctions.ts";

if (typeof window !== "undefined") {
  throw new Error("Sanctions screening cannot load in the browser.");
}

const HISTORY_MS = 12 * 60 * 60 * 1000;
const ETH_PAGE = 100;
const ETH_MAX_PAGES = 20;
const SOL_PAGE = 1000;
const SOL_MAX_PAGES = 2;
const SOL_BATCH = 20;
const historyFile = path.join(process.cwd(), "data", "ofac-history.json");
const SOL_HISTORY = "https://solana-rpc.publicnode.com";
const SOL_DEVNET_HISTORY = "https://api.devnet.solana.com";
const ETH_HISTORY = "https://eth.blockscout.com";
const ETH_SEPOLIA_HISTORY = "https://eth-sepolia.blockscout.com";

type Verdict = { at: number; listAt: number; hit: boolean };
type ListSets = { fetchedAt: number; eth: Set<string>; sol: Set<string> };
type ExplorerTx = { from?: string; to?: string; contractAddress?: string; hash?: string };

const memory = new Map<string, Verdict>();
const inflight = new Map<string, Promise<boolean>>();
let diskRead = false;

export function ethParties(tx: ExplorerTx, wallet: string): string[] {
  const own = wallet.toLowerCase();
  return [tx.from, tx.to, tx.contractAddress]
    .map((value) => value?.trim().toLowerCase() ?? "")
    .filter((value) => /^0x[0-9a-f]{40}$/.test(value) && value !== own);
}

export function solanaAccounts(tx: unknown): string[] {
  if (!tx || typeof tx !== "object") return [];
  const record = tx as {
    transaction?: { message?: { accountKeys?: unknown[] } };
    meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } };
  };
  const raw = record.transaction?.message?.accountKeys ?? [];
  const keys = raw.map((key) => typeof key === "string" ? key : (key as { pubkey?: string })?.pubkey ?? "");
  const loaded = record.meta?.loadedAddresses;
  return [...keys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].filter((key) => key.length > 0);
}

/**
 * The accounts in a transaction that count as this wallet's counterparties.
 *
 * Anyone can name any address in a transaction without its consent, so being
 * listed beside a sanctioned address proves nothing. A signature does. When the
 * wallet signed, every account it touched counts. When it did not, only the
 * signers count: a listed address that signed really did send to this wallet.
 */
export function solanaParties(tx: unknown, wallet: string): string[] {
  const accounts = solanaAccounts(tx);
  const required = (tx as { transaction?: { message?: { header?: { numRequiredSignatures?: unknown } } } } | null)
    ?.transaction?.message?.header?.numRequiredSignatures;
  // Without the signer count there is no way to tell, so keep every account.
  if (typeof required !== "number" || !Number.isInteger(required) || required < 1) return accounts;
  const signers = accounts.slice(0, required);
  return signers.includes(wallet) ? accounts : signers;
}

/**
 * A token contract can log a transfer between any two addresses. Count a token
 * row only when it belongs to a transaction this wallet sent.
 */
export function tokenRowCounts(row: ExplorerTx, signed: Set<string>): boolean {
  return signed.has(row.hash?.trim().toLowerCase() ?? "");
}

/** A transaction the node did not return is not a clean result. */
export function accountsOrRefuse(tx: unknown): string[] {
  const keys = solanaAccounts(tx);
  if (keys.length === 0) throw new Error("This wallet's history could not be checked. Try again shortly.");
  return keys;
}

export async function scanPages(
  load: (page: number) => Promise<{ parties: string[]; full: boolean }>,
  sanctioned: Set<string>,
  normalize: (value: string) => string,
  maxPages: number,
): Promise<"clear" | "hit"> {
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await load(page);
    for (const party of batch.parties) {
      if (sanctioned.has(normalize(party))) return "hit";
    }
    if (!batch.full) return "clear";
  }
  throw new Error("This wallet's history is too long to finish checking.");
}

export async function scanSignaturePages(
  load: (before?: string) => Promise<{ accounts: string[]; full: boolean; cursor?: string }>,
  sanctioned: Set<string>,
  maxPages: number,
): Promise<"clear" | "hit"> {
  let before: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await load(before);
    for (const account of batch.accounts) {
      if (sanctioned.has(account)) return "hit";
    }
    if (!batch.full) return "clear";
    if (!batch.cursor) throw new Error("This wallet's history could not be checked. Try again shortly.");
    before = batch.cursor;
  }
  throw new Error("This wallet's history is too long to finish checking.");
}

/** Read-only history check. This client never sends a transaction. */
export async function assertNoExposure(cluster: Cluster, wallet: string, list: ListSets): Promise<void> {
  const key = `${cluster}:${isEthCluster(cluster) ? wallet.toLowerCase() : wallet}:${list.fetchedAt}`;
  const cached = recall(key, list.fetchedAt);
  if (cached) {
    if (cached.hit) throw exposureDenied();
    return;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = scan(cluster, wallet, list).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  const hit = await pending;
  remember(key, { at: Date.now(), listAt: list.fetchedAt, hit });
  if (hit) throw exposureDenied();
}

async function scan(cluster: Cluster, wallet: string, list: ListSets): Promise<boolean> {
  if (isEthCluster(cluster)) {
    const bases = cluster === "ethereum" ? [ETH_HISTORY] : [ETH_HISTORY, ETH_SEPOLIA_HISTORY];
    const results = await Promise.all(bases.map((base) => scanEthBase(base, wallet, list.eth)));
    return results.includes("hit");
  }
  const endpoints = cluster === "devnet" ? [SOL_HISTORY, SOL_DEVNET_HISTORY] : [SOL_HISTORY];
  const results = await Promise.all(endpoints.map((endpoint) => scanSol(endpoint, wallet, list.sol)));
  return results.includes("hit");
}

/** Plain and internal transfers first. They also say which transactions the wallet sent itself. */
async function scanEthBase(base: string, wallet: string, sanctioned: Set<string>): Promise<"clear" | "hit"> {
  const own = wallet.toLowerCase();
  const signed = new Set<string>();
  const [direct, internal] = await Promise.all([
    scanEth(base, "txlist", wallet, sanctioned, (row) => {
      if (row.from?.trim().toLowerCase() === own && row.hash) signed.add(row.hash.trim().toLowerCase());
      return true;
    }),
    scanEth(base, "txlistinternal", wallet, sanctioned, () => true),
  ]);
  if (direct === "hit" || internal === "hit") return "hit";
  return scanEth(base, "tokentx", wallet, sanctioned, (row) => tokenRowCounts(row, signed));
}

async function scanEth(
  base: string,
  action: string,
  wallet: string,
  sanctioned: Set<string>,
  counts: (row: ExplorerTx) => boolean,
): Promise<"clear" | "hit"> {
  return scanPages(async (page) => {
    const url = `${base}/api?${new URLSearchParams({
      module: "account",
      action,
      address: wallet,
      page: String(page),
      offset: String(ETH_PAGE),
      sort: "desc",
    })}`;
    const body = await getJson(url);
    const rows = explorerRows(body);
    const parties = rows.filter(counts).flatMap((row) => ethParties(row, wallet));
    return { parties, full: rows.length >= ETH_PAGE };
  }, sanctioned, (value) => value.toLowerCase(), ETH_MAX_PAGES);
}

async function scanSol(endpoint: string, wallet: string, sanctioned: Set<string>): Promise<"clear" | "hit"> {
  return scanSignaturePages(async (before) => {
    const page = await solSignatures(endpoint, wallet, before);
    if (page.length === 0) return { accounts: [], full: false };
    const accounts: string[] = [];
    for (let index = 0; index < page.length; index += SOL_BATCH) {
      const slice = page.slice(index, index + SOL_BATCH);
      const txs = await solTransactions(endpoint, slice.map((row) => row.signature));
      for (const tx of txs) {
        accountsOrRefuse(tx);
        accounts.push(...solanaParties(tx, wallet));
      }
    }
    return { accounts, full: page.length >= SOL_PAGE, cursor: page[page.length - 1]?.signature };
  }, sanctioned, SOL_MAX_PAGES);
}

async function solSignatures(endpoint: string, wallet: string, before?: string): Promise<{ signature: string }[]> {
  const config: { limit: number; before?: string } = { limit: SOL_PAGE };
  if (before) config.before = before;
  const body = await rpc(endpoint, { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [wallet, config] });
  if (!Array.isArray(body.result)) throw new Error("This wallet's history could not be checked. Try again shortly.");
  return body.result.map((row) => {
    const signature = (row as { signature?: unknown })?.signature;
    if (typeof signature !== "string" || signature.length === 0) {
      throw new Error("This wallet's history could not be checked. Try again shortly.");
    }
    return { signature };
  });
}

async function solTransactions(endpoint: string, signatures: string[]): Promise<unknown[]> {
  const payload = signatures.map((signature, index) => ({
    jsonrpc: "2.0",
    id: index,
    method: "getTransaction",
    params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
  }));
  const body = await rpc(endpoint, payload);
  if (!Array.isArray(body)) throw new Error("This wallet's history could not be checked. Try again shortly.");
  const byId = new Map<number, unknown>();
  for (const item of body as { id?: number; result?: unknown; error?: unknown }[]) {
    if (item.error) throw new Error("This wallet's history could not be checked. Try again shortly.");
    if (typeof item.id === "number") byId.set(item.id, item.result);
  }
  return signatures.map((_, index) => byId.get(index));
}

function explorerRows(body: unknown): ExplorerTx[] {
  if (!body || typeof body !== "object") throw new Error("This wallet's history could not be checked. Try again shortly.");
  const record = body as { message?: string; result?: unknown };
  if (Array.isArray(record.result)) return record.result as ExplorerTx[];
  const message = `${record.message ?? ""} ${typeof record.result === "string" ? record.result : ""}`.toLowerCase();
  if (message.includes("no transaction") || message.includes("no token") || message.includes("no internal")) return [];
  throw new Error("This wallet's history could not be checked. Try again shortly.");
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error("This wallet's history could not be checked. Try again shortly.");
  return response.json();
}

async function rpc(endpoint: string, payload: unknown): Promise<{ result?: unknown }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error("This wallet's history could not be checked. Try again shortly.");
  return response.json() as Promise<{ result?: unknown }>;
}

export function exposureDenied(): SanctionedWalletError {
  return new SanctionedWalletError("That wallet has transacted with an address on the U.S. sanctions list.");
}

function recall(key: string, listAt: number): Verdict | undefined {
  loadDisk();
  const found = memory.get(key);
  if (!found || found.listAt !== listAt || Date.now() - found.at >= HISTORY_MS) return undefined;
  return found;
}

function remember(key: string, verdict: Verdict): void {
  memory.set(key, verdict);
  const body: Record<string, Verdict> = {};
  for (const [saved, value] of memory) body[saved] = value;
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  const tmp = `${historyFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, historyFile);
}

function loadDisk(): void {
  if (diskRead) return;
  diskRead = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, "utf8")) as Record<string, Verdict>;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.at === "number" && typeof value.listAt === "number" && typeof value.hit === "boolean") {
        memory.set(key, value);
      }
    }
  } catch {
    // A missing cache only means the next wallet has to be read from the chain.
  }
}
