import fs from "node:fs";
import path from "node:path";
import { isEthCluster, type Cluster } from "../table-view.ts";
import { assertNoExposure } from "./exposure.ts";
import { assertWallet } from "./keys.ts";

if (typeof window !== "undefined") {
  throw new Error("Sanctions screening cannot load in the browser.");
}

const SOURCE = "https://sanctionslistservice.ofac.treas.gov/api/download/SDN_ADVANCED.XML";
const FRESH_MS = 12 * 60 * 60 * 1000;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const file = path.join(process.cwd(), "data", "ofac.json");

export class SanctionedWalletError extends Error {
  constructor(message = "That wallet is on the U.S. sanctions list.") {
    super(message);
    this.name = "SanctionedWalletError";
  }
}

type AddressCache = { fetchedAt: number; eth: string[]; sol: string[] };
type AddressSets = { fetchedAt: number; eth: Set<string>; sol: Set<string> };

let memory: AddressSets | null = null;
let loading: Promise<AddressSets> | null = null;

/** Pull ETH and SOL addresses out of the OFAC SDN advanced XML. */
export function addressesFromSdn(xml: string, fetchedAt = Date.now()): AddressCache {
  const ethIds = new Set<string>();
  const solIds = new Set<string>();
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<FeatureType ", cursor);
    if (start < 0) break;
    const end = xml.indexOf("</FeatureType>", start);
    if (end < 0) break;
    const tag = xml.slice(start, end);
    cursor = end + "</FeatureType>".length;
    const nameAt = tag.indexOf(">");
    const name = tag.slice(nameAt + 1).trim();
    if (!name.startsWith("Digital Currency Address - ")) continue;
    const id = /ID="(\d+)"/.exec(tag)?.[1];
    if (!id) continue;
    const asset = name.slice("Digital Currency Address - ".length).trim().toUpperCase();
    if (asset === "SOL") solIds.add(id);
    else ethIds.add(id);
  }
  if (ethIds.size === 0 || solIds.size === 0) {
    throw new Error("The sanctions list format was not recognized.");
  }
  const eth = new Set<string>();
  const sol = new Set<string>();
  cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<Feature ", cursor);
    if (start < 0) break;
    const end = xml.indexOf("</Feature>", start);
    if (end < 0) break;
    const openEnd = xml.indexOf(">", start);
    const id = /FeatureTypeID="(\d+)"/.exec(xml.slice(start, openEnd + 1))?.[1];
    cursor = end + "</Feature>".length;
    if (!id || (!ethIds.has(id) && !solIds.has(id))) continue;
    const block = xml.slice(start, end);
    const detail = /<VersionDetail\b[^>]*>([^<]*)<\/VersionDetail>/.exec(block);
    const address = decodeXml(detail?.[1]?.trim() ?? "");
    if (!address) continue;
    if (solIds.has(id)) sol.add(address);
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) eth.add(address.toLowerCase());
  }
  return { fetchedAt, eth: [...eth], sol: [...sol] };
}

export function isListed(cluster: Cluster, wallet: string, list: Pick<AddressCache, "eth" | "sol">): boolean {
  if (!wallet) return false;
  if (isEthCluster(cluster)) return list.eth.includes(wallet.toLowerCase());
  return list.sol.includes(wallet);
}

/** Refuse a listed wallet. A missing list refuses too. */
export async function assertClear(cluster: Cluster, wallet: string): Promise<void> {
  if (!wallet) return;
  const list = await currentList();
  const hit = isEthCluster(cluster) ? list.eth.has(wallet.toLowerCase()) : list.sol.has(wallet);
  if (hit) throw new SanctionedWalletError();
  await assertNoExposure(cluster, wallet, list);
}

/** Screen a connected wallet. Ignore a header that is not an address. */
export async function assertClearIfWallet(cluster: Cluster, wallet: string): Promise<void> {
  const value = wallet.trim();
  if (!value) return;
  try {
    assertWallet(cluster, value);
  } catch {
    return;
  }
  await assertClear(cluster, value);
}

async function currentList(): Promise<AddressSets> {
  const cached = memory ?? readCache();
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) {
    memory = cached;
    return cached;
  }
  if (!loading) {
    loading = refresh().finally(() => {
      loading = null;
    });
  }
  return loading;
}

async function refresh(): Promise<AddressSets> {
  const cached = memory ?? readCache();
  try {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`The sanctions list returned ${response.status}.`);
    const next = setsFrom(addressesFromSdn(await response.text()));
    memory = next;
    writeCache(next);
    return next;
  } catch (error) {
    if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
      memory = cached;
      return cached;
    }
    if (error instanceof Error && error.message === "The sanctions list format was not recognized.") throw error;
    throw new Error("The sanctions list could not be loaded. Try again shortly.");
  }
}

function setsFrom(cache: AddressCache): AddressSets {
  return { fetchedAt: cache.fetchedAt, eth: new Set(cache.eth), sol: new Set(cache.sol) };
}

function readCache(): AddressSets | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AddressCache>;
    if (!parsed || typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.eth) || !Array.isArray(parsed.sol)) return null;
    return setsFrom({ fetchedAt: parsed.fetchedAt, eth: parsed.eth, sol: parsed.sol });
  } catch {
    return null;
  }
}

function writeCache(list: AddressSets): void {
  const body: AddressCache = { fetchedAt: list.fetchedAt, eth: [...list.eth], sol: [...list.sol] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, file);
}

function decodeXml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
