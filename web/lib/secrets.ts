export type SeatSecrets = {
  owner: string;
  role: "player" | "dealer";
  seeds: string[];
};

const PREFIX = "sol-blackjack:v1:";

function storageKey(table: string, role: SeatSecrets["role"]): string {
  return `${PREFIX}${role}:${table}`;
}

export function saveSecrets(table: string, secrets: SeatSecrets): void {
  localStorage.setItem(storageKey(table, secrets.role), JSON.stringify(secrets));
}

export function moveSecrets(from: string, to: string, role: SeatSecrets["role"]): void {
  const saved = loadSecrets(from, role);
  if (!saved) return;
  saveSecrets(to, saved);
  localStorage.removeItem(storageKey(from, role));
}

export function loadSecrets(table: string, role: SeatSecrets["role"]): SeatSecrets | null {
  const raw = localStorage.getItem(storageKey(table, role));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SeatSecrets;
    if (!Array.isArray(parsed.seeds) || parsed.seeds.length !== 16) return null;
    if (parsed.role !== "player" && parsed.role !== "dealer") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function newShoe(): Promise<{ seeds: Uint8Array[]; commits: Uint8Array }> {
  const seeds = Array.from({ length: 16 }, () => crypto.getRandomValues(new Uint8Array(32)));
  const commits = await commitsFor(seeds);
  return { seeds, commits };
}

export async function commitsFor(seeds: Uint8Array[]): Promise<Uint8Array> {
  const commits = new Uint8Array(seeds.length * 32);
  for (let i = 0; i < seeds.length; i += 1) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seeds[i]!.slice()));
    commits.set(digest, i * 32);
  }
  return commits;
}

/** Reuse secrets already stored for this seat so a retried transaction cannot change the commitment. */
export async function shoeFor(
  table: string,
  owner: string,
  role: "player" | "dealer",
): Promise<{ seeds: Uint8Array[]; commits: Uint8Array }> {
  const existing = loadSecrets(table, role);
  if (existing && existing.owner === owner && existing.role === role) {
    const seeds = existing.seeds.map(b64ToBytes);
    return { seeds, commits: await commitsFor(seeds) };
  }
  const fresh = await newShoe();
  saveSecrets(table, { owner, role, seeds: fresh.seeds.map(bytesToB64) });
  return fresh;
}
