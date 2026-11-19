import { UniversalProvider } from "@walletconnect/universal-provider";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEventLogs,
  toHex,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
} from "viem";
import { mainnet, sepolia } from "viem/chains";

export const SEPOLIA_ID = 11155111;
export const SEPOLIA_HEX = "0xaa36a7";
export const ETHEREUM_ID = 1;
export const ETHEREUM_HEX = "0x1";
export type EthChainName = "sepolia" | "ethereum";
export const MIN_STAKE = 10_000_000_000_000_000n;
export const MAX_STAKE = 50n * 10n ** 18n;

const RPC = process.env.NEXT_PUBLIC_ETH_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ETHEREUM_RPC = "https://ethereum-rpc.publicnode.com";
const configured = process.env.NEXT_PUBLIC_ETH_BLACKJACK_ADDRESS ?? "";

export const BLACKJACK_ADDRESS: Address | null = /^0x[0-9a-fA-F]{40}$/.test(configured)
  ? configured as Address
  : null;

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(RPC),
});

export const mainnetPublicClient = createPublicClient({
  chain: mainnet,
  transport: http(ETHEREUM_RPC),
});

export const blackjackAbi = [
  {
    type: "function",
    name: "createGame",
    stateMutability: "payable",
    inputs: [
      { name: "stake", type: "uint256" },
      { name: "invite", type: "address" },
      { name: "commits", type: "bytes32[16]" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "joinGame",
    stateMutability: "payable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "commits", type: "bytes32[16]" },
    ],
    outputs: [],
  },
  { type: "function", name: "cancelGame", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "hit", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "stand", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "dealerRevealOpening",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "seeds", type: "bytes32[3]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "playerRevealOpening",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "seeds", type: "bytes32[3]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "dealerRevealHit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "seed", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "playerRevealHit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "seed", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "dealerRevealShowdown",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "hole", type: "bytes32" },
      { name: "hits", type: "bytes32[6]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "playerRevealShowdown",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "hole", type: "bytes32" },
      { name: "hits", type: "bytes32[6]" },
    ],
    outputs: [],
  },
  { type: "function", name: "claimTimeout", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "getTable",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "player", type: "address" },
      { name: "dealer", type: "address" },
      { name: "invite", type: "address" },
      { name: "stake", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "outcome", type: "uint8" },
      { name: "playerLen", type: "uint8" },
      { name: "dealerLen", type: "uint8" },
      { name: "nextPlayerHit", type: "uint8" },
      { name: "deadline", type: "uint64" },
      { name: "pot", type: "uint256" },
      { name: "playerCards", type: "uint8[11]" },
      { name: "dealerCards", type: "uint8[11]" },
    ],
  },
  {
    type: "event",
    name: "TableCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
    ],
  },
] as const;

type GameName = ContractFunctionName<typeof blackjackAbi, "nonpayable" | "payable">;
type GameArgs<name extends GameName> = ContractFunctionArgs<typeof blackjackAbi, "nonpayable" | "payable", name>;

export type Bytes3 = readonly [Hex, Hex, Hex];
export type Bytes6 = readonly [Hex, Hex, Hex, Hex, Hex, Hex];
export type Bytes16 = readonly [
  Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex,
  Hex, Hex, Hex, Hex, Hex, Hex, Hex, Hex,
];

export type EthProvider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  disconnect?: () => Promise<void>;
  session?: { namespaces?: { eip155?: { accounts?: string[] } } };
  setDefaultChain?: (chain: string) => void;
};

declare global {
  interface Window {
    ethereum?: EthProvider;
  }
}

export type EthTable = {
  player: Address;
  dealer: Address;
  invite: Address;
  stake: bigint;
  status: number;
  outcome: number;
  playerLen: number;
  dealerLen: number;
  nextPlayerHit: number;
  deadline: bigint;
  pot: bigint;
  playerCards: number[];
  dealerCards: number[];
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MAINNET_ERROR = "Switch the wallet to Ethereum Sepolia. This table does not use mainnet.";

export function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 14n;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}

export function parseEth(value: string): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!match) throw new Error("Enter a buy-in in ETH.");
  const whole = BigInt(match[1] ?? "0");
  const frac = (match[2] ?? "").padEnd(18, "0");
  const wei = whole * 10n ** 18n + BigInt(frac);
  if (wei < MIN_STAKE || wei > MAX_STAKE) throw new Error("Buy-in must be between 0.01 and 50 ETH.");
  return wei;
}

export function shortAddress(value: string): string {
  return value.length < 10 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function fixed<T extends readonly Hex[]>(values: Hex[], size: number): T {
  if (values.length !== size) throw new Error("Card secrets are incomplete.");
  return values as unknown as T;
}

export function commitsOf(bytes: Uint8Array): Bytes16 {
  if (bytes.length !== 512) throw new Error("Card commitments are incomplete.");
  const out: Hex[] = [];
  for (let i = 0; i < 16; i += 1) out.push(toHex(bytes.subarray(i * 32, (i + 1) * 32)));
  return fixed(out, 16);
}

export function seedOf(seed: Uint8Array): Hex {
  if (seed.length !== 32) throw new Error("A card secret is missing.");
  return toHex(seed);
}

export function openingSeeds(seeds: Uint8Array[]): Bytes3 {
  return fixed([0, 1, 2].map((index) => seedOf(mustSeed(seeds, index))), 3);
}

export function hitSeed(seeds: Uint8Array[], nextPlayerHit: number): Hex {
  return seedOf(mustSeed(seeds, 4 + nextPlayerHit));
}

export function showdownSeeds(seeds: Uint8Array[]): { hole: Hex; hits: Bytes6 } {
  const hits = [10, 11, 12, 13, 14, 15].map((index) => seedOf(mustSeed(seeds, index)));
  return { hole: seedOf(mustSeed(seeds, 3)), hits: fixed(hits, 6) };
}

function mustSeed(seeds: Uint8Array[], index: number): Uint8Array {
  const seed = seeds[index];
  if (!seed) throw new Error("A card secret is missing.");
  return seed;
}

export async function readTable(id: bigint): Promise<EthTable | null> {
  if (!BLACKJACK_ADDRESS) return null;
  const result = await publicClient.readContract({
    address: BLACKJACK_ADDRESS,
    abi: blackjackAbi,
    functionName: "getTable",
    args: [id],
  });
  const [
    player, dealer, invite, stake, status, outcome, playerLen, dealerLen, nextPlayerHit, deadline, pot, playerCards, dealerCards,
  ] = result;
  if (player === ZERO) return null;
  return {
    player,
    dealer,
    invite,
    stake,
    status,
    outcome,
    playerLen,
    dealerLen,
    nextPlayerHit,
    deadline,
    pot,
    playerCards: [...playerCards].slice(0, playerLen),
    dealerCards: [...dealerCards].slice(0, dealerLen),
  };
}

export async function writeGame<name extends GameName>(
  provider: EthProvider,
  account: Address,
  functionName: name,
  args: GameArgs<name>,
  value?: bigint,
): Promise<Hex> {
  if (!BLACKJACK_ADDRESS) throw new Error("The Ethereum contract is not deployed yet.");
  await ensureSepolia(provider);
  const chainId = chainNumber(await provider.request({ method: "eth_chainId" }));
  if (chainId !== SEPOLIA_ID) throw new Error(MAINNET_ERROR);
  const client = createWalletClient({
    account,
    chain: sepolia,
    transport: custom(provider),
  });
  return client.writeContract({
    address: BLACKJACK_ADDRESS,
    abi: blackjackAbi,
    functionName,
    args,
    chain: sepolia,
    account,
    ...(value === undefined ? {} : { value }),
  } as never);
}

export async function createdTableId(hash: Hex): Promise<bigint> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const parsed = parseEventLogs({ abi: blackjackAbi, logs: receipt.logs, eventName: "TableCreated" });
  const id = parsed[0]?.args.id;
  if (id === undefined) throw new Error("The table was sent, but the contract did not return an id.");
  return id;
}

let wcProvider: InstanceType<typeof UniversalProvider> | null = null;
let connectReject: ((error: Error) => void) | null = null;

export function cancelWalletConnect(): void {
  const reject = connectReject;
  connectReject = null;
  try {
    wcProvider?.abortPairingAttempt();
  } catch {
    // Pairing may already have finished.
  }
  void wcProvider?.disconnect().catch(() => undefined);
  reject?.(new Error("WalletConnect was cancelled."));
}

export async function connectInjected(chain: EthChainName = "sepolia"): Promise<{ provider: EthProvider; account: Address }> {
  const provider = window.ethereum;
  if (!provider) throw new Error("Install MetaMask, or use WalletConnect.");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
  const account = accounts[0];
  if (!account) throw new Error("The wallet did not share an account.");
  if (chain === "ethereum") await ensureEthereum(provider);
  else await ensureSepolia(provider);
  return { provider, account: account as Address };
}

export async function connectWalletConnect(
  projectId: string,
  onUri: (uri: string) => void,
  chain: EthChainName = "sepolia",
): Promise<{ provider: EthProvider; account: Address }> {
  if (!projectId) throw new Error("Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID and restart the dev server.");
  if (!wcProvider) {
    wcProvider = await UniversalProvider.init({
      projectId,
      metadata: {
        name: "Blackjack",
        description: "Two-player blackjack. Sepolia uses test ETH. Ethereum mainnet uses real ETH.",
        url: window.location.origin,
        icons: [],
      },
    });
  }
  const provider = wcProvider;
  if (!provider.session) {
    let settled = false;
    const onDisplay = (uri: unknown) => {
      if (typeof uri === "string") onUri(uri);
    };
    provider.on("display_uri", onDisplay);
    try {
      await new Promise<void>((resolve, reject) => {
        connectReject = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        provider.connect({
          optionalNamespaces: {
            eip155: {
              chains: ["eip155:11155111", "eip155:1"],
              methods: [
                "eth_sendTransaction",
                "personal_sign",
                "eth_signTypedData_v4",
                "wallet_switchEthereumChain",
                "wallet_addEthereumChain",
              ],
              events: ["chainChanged", "accountsChanged"],
            },
          },
        }).then(
          () => {
            if (settled) {
              void provider.disconnect().catch(() => undefined);
              return;
            }
            settled = true;
            connectReject = null;
            resolve();
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            connectReject = null;
            reject(error instanceof Error ? error : new Error("WalletConnect could not connect."));
          },
        );
      });
    } finally {
      provider.removeListener("display_uri", onDisplay);
      connectReject = null;
    }
  }
  const accounts = provider.session?.namespaces.eip155?.accounts ?? [];
  const prefix = chain === "ethereum" ? "eip155:1:" : "eip155:11155111:";
  const matched = accounts.find((item: string) => item.startsWith(prefix)) ?? accounts[0];
  const address = matched?.split(":")[2];
  if (!address) throw new Error("The wallet did not share an Ethereum account.");
  provider.setDefaultChain(chain === "ethereum" ? "eip155:1" : "eip155:11155111");
  const ethereumProvider = provider as unknown as EthProvider;
  if (chain === "ethereum") await ensureEthereum(ethereumProvider);
  else await ensureSepolia(ethereumProvider);
  return { provider: ethereumProvider, account: address as Address };
}

export async function ensureSepolia(provider: EthProvider): Promise<void> {
  if (chainNumber(await provider.request({ method: "eth_chainId" })) === SEPOLIA_ID) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }],
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: SEPOLIA_HEX,
        chainName: "Sepolia",
        nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: [RPC],
        blockExplorerUrls: ["https://sepolia.etherscan.io"],
      }],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }],
    });
  }
  if (chainNumber(await provider.request({ method: "eth_chainId" })) !== SEPOLIA_ID) {
    throw new Error(MAINNET_ERROR);
  }
}

export async function ensureEthereum(provider: EthProvider): Promise<void> {
  if (chainNumber(await provider.request({ method: "eth_chainId" })) === ETHEREUM_ID) return;
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: ETHEREUM_HEX }],
  });
  if (chainNumber(await provider.request({ method: "eth_chainId" })) !== ETHEREUM_ID) {
    throw new Error("Switch the wallet to Ethereum mainnet.");
  }
}

function chainNumber(value: unknown): number | null {
  if (typeof value === "string") return Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}
