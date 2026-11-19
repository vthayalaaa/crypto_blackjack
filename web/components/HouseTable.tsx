"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createWalletClient, custom, type Address } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { chatAccess } from "../lib/chat";
import { handTotal } from "../lib/cards";
import { formatSol } from "../lib/chain";
import {
  ETHEREUM_ID,
  SEPOLIA_ID,
  cancelWalletConnect,
  connectInjected,
  connectWalletConnect,
  ensureEthereum,
  ensureSepolia,
  formatEth,
  mainnetPublicClient,
  publicClient,
  shortAddress,
  type EthChainName,
  type EthProvider,
} from "../lib/eth";
import { STAKE_CHIPS, type LobbyCounts } from "../lib/stakes";
import { profileChainOf } from "../lib/profile";
import { chainFromUrl, isEthCluster, networkHref, networkLabel, type Cluster, type TableView } from "../lib/table-view";
import { WALLETCONNECT_PROJECT_ID, useCluster, type ClusterName } from "./Providers";
import { PlayingCard } from "./PlayingCard";
import { TableChat } from "./TableChat";
import { WalletMenu } from "./WalletMenu";

type EthSession = { provider: EthProvider; account: Address; kind: "injected" | "walletconnect" };

function money(cluster: Cluster, amount: string): string {
  if (!amount) return "—";
  return isEthCluster(cluster) ? `${formatEth(BigInt(amount))} ETH` : `${formatSol(BigInt(amount))} SOL`;
}

function short(value: string): string {
  if (!value) return "—";
  return value.startsWith("0x") ? shortAddress(value) : value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function AddressChip({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  function place() {
    const node = root.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setFlip(rect.left + 260 > window.innerWidth - 12);
  }

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className={open ? "addr open" : "addr"} ref={root} onMouseEnter={place}>
      <button type="button" className="addr-short" aria-expanded={open} onClick={() => { place(); setOpen((current) => !current); }}>
        {short(value)}
      </button>
      <span className={flip ? "addr-pop flip" : "addr-pop"}>
        <span className="addr-full">{value}</span>
        <button className="addr-copy" type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
      </span>
    </span>
  );
}

function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : "The table could not do that.";
  if (/user rejected|rejected the request|4001/i.test(message)) return "The wallet closed the request.";
  return message.length > 280 ? `${message.slice(0, 280)}…` : message;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The table could not do that.");
  return body;
}

export function HouseTable({
  network,
  supabaseUrl = "",
  supabaseKey = "",
}: {
  network: Cluster;
  supabaseUrl?: string;
  supabaseKey?: string;
}) {
  const params = useSearchParams();
  const tableId = params.get("table");
  const router = useRouter();
  const { cluster, setCluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [stake, setStake] = useState("0.05");
  const [seatCount, setSeatCount] = useState(2);
  const [invite, setInvite] = useState("");
  const [mode, setMode] = useState<"invite" | "match">("invite");
  const [waiting, setWaiting] = useState<{ stake: string; cluster: Cluster; others: number; seats: number } | null>(null);
  const [lobby, setLobby] = useState<LobbyCounts | null>(null);
  const [mine, setMine] = useState<CurrentTable[] | null>(null);
  const [mineFor, setMineFor] = useState(network);
  const [view, setView] = useState<TableView | null>(null);
  const [missing, setMissing] = useState(false);
  const [eth, setEth] = useState<EthSession | null>(null);
  const [balance, setBalance] = useState<string>("—");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<"injected" | "walletconnect" | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const scanning = useRef(false);
  const wcGen = useRef(0);
  const presenceBeat = useRef(0);
  const liveBeat = useRef(0);
  const walletRef = useRef("");
  const active = view?.cluster ?? network;
  walletRef.current = (isEthCluster(active) ? eth?.account : publicKey?.toBase58()) ?? "";
  if (mineFor !== network) {
    setMineFor(network);
    setMine(null);
  }

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!view || !tableId || view.cluster === network) return;
    setCluster(view.cluster);
    router.replace(networkHref(view.cluster, tableId));
  }, [view, tableId, network, router, setCluster]);

  const linkedAccount = (isEthCluster(active) ? eth?.account : publicKey?.toBase58()) ?? "";
  const linkedChain = isEthCluster(active) ? "ethereum" : "solana";
  useEffect(() => {
    if (!linkedAccount) return;
    const controller = new AbortController();
    void fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chain: linkedChain, address: linkedAccount }),
      signal: controller.signal,
    }).catch(() => undefined);
    return () => controller.abort();
  }, [linkedAccount, linkedChain]);

  useEffect(() => () => {
    if (scanning.current) cancelWalletConnect();
  }, []);

  function tablePath(id: string): string {
    const beat = liveBeat.current;
    return beat > 0 ? `/api/tables/${id}?beat=${beat}` : `/api/tables/${id}`;
  }

  function walletHeaders(): HeadersInit {
    return walletRef.current ? { "x-bj-wallet": walletRef.current } : {};
  }

  async function refresh() {
    if (!tableId) return;
    const body = await api<{ table: TableView }>(tablePath(tableId), { headers: walletHeaders() });
    setView(body.table);
    setMissing(false);
  }

  useEffect(() => {
    if (tableId) return;
    let cancelled = false;
    const tick = () => {
      void api<MatchState>("/api/match").then((body) => {
        if (cancelled) return;
        if (body.status === "matched") {
          setWaiting(null);
          go(body.table.id, body.table.cluster);
          return;
        }
        setWaiting(body.status === "waiting" ? { stake: body.stake, cluster: body.cluster, others: body.others, seats: body.seats } : null);
      }).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tableId]);

  useEffect(() => {
    if (tableId) return;
    let cancelled = false;
    const tick = () => {
      void api<LobbyCounts>(`/api/lobby?cluster=${network}`).then((body) => {
        if (!cancelled) setLobby(body);
      }).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tableId, network]);

  const seatedWallet = (isEthCluster(network) ? eth?.account : publicKey?.toBase58()) ?? "";
  useEffect(() => {
    if (!seatedWallet) {
      setMine([]);
      return;
    }
    if (tableId && !missing) return;
    let cancelled = false;
    const tick = () => {
      void api<{ tables: CurrentTable[] }>(`/api/tables/mine?cluster=${encodeURIComponent(network)}`, {
        headers: walletHeaders(),
      }).then((body) => {
        if (!cancelled) setMine(Array.isArray(body.tables) ? body.tables : []);
      }).catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tableId, missing, network, seatedWallet]);

  useEffect(() => {
    if (!tableId) {
      setView(null);
      setMissing(false);
      return;
    }
    const id = tableId;
    let cancelled = false;
    const beat = ++presenceBeat.current;
    liveBeat.current = beat;
    const tick = () => {
      const current = liveBeat.current;
      const url = current > 0 ? `/api/tables/${id}?beat=${current}` : `/api/tables/${id}`;
      void api<{ table: TableView }>(url, { headers: walletHeaders() }).then((body) => {
        if (!cancelled) {
          setView(body.table);
          setMissing(false);
        }
      }).catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof Error && /no table/i.test(caught.message)) {
          setView(null);
          setMissing(true);
          return;
        }
        setError(explain(caught));
      });
    };
    const leave = () => {
      if (liveBeat.current === 0) return;
      const bye = ++presenceBeat.current;
      liveBeat.current = 0;
      void fetch(`/api/tables/${id}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ present: false, beat: bye }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted || liveBeat.current !== 0) return;
      liveBeat.current = ++presenceBeat.current;
      tick();
    };
    tick();
    const timer = window.setInterval(tick, 3000);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", onShow);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", onShow);
      leave();
    };
  }, [tableId]);

  useEffect(() => {
    if (isEthCluster(active)) {
      if (!eth) {
        setBalance("—");
        return;
      }
      let cancelled = false;
      const client = active === "ethereum" ? mainnetPublicClient : publicClient;
      void client.getBalance({ address: eth.account }).then((value) => {
        if (!cancelled) setBalance(`${formatEth(value)} ETH`);
      }).catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    if (!publicKey) {
      setBalance("—");
      return;
    }
    let cancelled = false;
    void connection.getBalance(publicKey).then((value) => {
      if (!cancelled) setBalance(`${formatSol(BigInt(value))} SOL`);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, connection, eth, publicKey, view?.phase]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
      if (tableId) await refresh();
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  }

  function go(id: string, cluster: Cluster) {
    router.push(networkHref(cluster, id));
  }

  async function reopen(row: CurrentTable) {
    const body = await api<{ id: string; cluster: Cluster }>("/api/tables/mine", {
      method: "POST",
      headers: walletHeaders(),
      body: JSON.stringify({ id: row.id }),
    });
    go(body.id, body.cluster);
  }

  async function createTable() {
    const body = await api<{ table: TableView }>("/api/tables", {
      method: "POST",
      body: JSON.stringify({ cluster: network, stake, invite, seats: seatCount, wallet: walletRef.current }),
    });
    go(body.table.id, body.table.cluster);
  }

  async function findMatch() {
    const wallet = isEthCluster(network) ? eth?.account : publicKey?.toBase58();
    if (!wallet) throw new Error("Connect a wallet first.");
    const body = await api<MatchState>("/api/match", {
      method: "POST",
      body: JSON.stringify({ cluster: network, stake, seats: seatCount, wallet }),
    });
    if (body.status === "matched") {
      setWaiting(null);
      go(body.table.id, body.table.cluster);
      return;
    }
    if (body.status === "waiting") setWaiting({ stake: body.stake, cluster: body.cluster, others: body.others, seats: body.seats });
  }

  async function leaveMatch() {
    const body = await api<MatchState>("/api/match", { method: "DELETE" });
    if (body.status === "matched") {
      go(body.table.id, body.table.cluster);
      return;
    }
    setWaiting(null);
  }

  async function joinTable() {
    if (!tableId) return;
    const wallet = isEthCluster(active) ? eth?.account : publicKey?.toBase58();
    if (!wallet) throw new Error("Connect a wallet first.");
    const open = view?.seats.findIndex((seat) => !seat.address) ?? 1;
    await api(`/api/tables/${tableId}/join`, { method: "POST", body: JSON.stringify({ wallet }) });
    setNotice(`You have player ${open + 1}. Send the same buy-in.`);
  }

  async function sendBuyIn() {
    if (!view?.depositAddress) throw new Error("This seat is already funded.");
    if (isEthCluster(view.cluster)) {
      if (!eth) throw new Error("Connect a wallet first.");
      const onMainnet = view.cluster === "ethereum";
      if (onMainnet) await ensureEthereum(eth.provider);
      else await ensureSepolia(eth.provider);
      const chainId = await eth.provider.request({ method: "eth_chainId" });
      const parsed = typeof chainId === "string" ? Number.parseInt(chainId, 16) : Number.NaN;
      const expected = onMainnet ? ETHEREUM_ID : SEPOLIA_ID;
      if (parsed !== expected) {
        throw new Error(onMainnet ? "Switch the wallet to Ethereum mainnet." : "Switch the wallet to Ethereum Sepolia.");
      }
      const chain = onMainnet ? mainnet : sepolia;
      const client = createWalletClient({ account: eth.account, chain, transport: custom(eth.provider) });
      const hash = await client.sendTransaction({
        account: eth.account,
        chain,
        to: view.depositAddress as Address,
        value: BigInt(view.due),
      });
      const reader = onMainnet ? mainnetPublicClient : publicClient;
      await reader.waitForTransactionReceipt({ hash });
      await api(`/api/tables/${view.id}/fund`, {
        method: "POST",
        body: JSON.stringify({ wallet: eth.account, signature: hash }),
      });
    } else {
      if (!publicKey) throw new Error("Connect a wallet first.");
      // The wallet RPC follows the selected network. An old devnet invite has no chain in the link, so refuse until that matches the table.
      if (view.cluster !== cluster) {
        setCluster(view.cluster);
        throw new Error(`This table is on ${networkLabel(view.cluster)}.`);
      }
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(view.depositAddress),
        lamports: Number(view.due),
      }));
      const signature = await sendTransaction(tx, connection);
      await connection.confirmTransaction(signature, "confirmed");
      await api(`/api/tables/${view.id}/fund`, {
        method: "POST",
        body: JSON.stringify({ wallet: publicKey.toBase58(), signature }),
      });
    }
    setNotice("Buy-in received.");
  }

  async function act(action: "hit" | "stand" | "cancel" | "claim" | "payout" | "vote") {
    if (!view) return;
    await api(`/api/tables/${view.id}/act`, { method: "POST", body: JSON.stringify({ action }) });
    if (action === "cancel") router.push(networkHref(view.cluster));
  }

  async function connectMetaMask() {
    setConnecting("injected");
    setError(null);
    try {
      const session = await connectInjected(active === "ethereum" ? "ethereum" : "sepolia");
      setEth({ ...session, kind: "injected" });
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setConnecting(null);
    }
  }

  async function connectCode() {
    const gen = wcGen.current + 1;
    wcGen.current = gen;
    scanning.current = true;
    setConnecting("walletconnect");
    setQr(null);
    setError(null);
    try {
      const chain: EthChainName = active === "ethereum" ? "ethereum" : "sepolia";
      const session = await connectWalletConnect(WALLETCONNECT_PROJECT_ID, (uri) => {
        if (wcGen.current !== gen) return;
        void import("qrcode").then(async (QR) => {
          const url = await QR.toDataURL(uri, { margin: 1, width: 280 });
          if (wcGen.current === gen) setQr(url);
        });
      }, chain);
      if (wcGen.current !== gen) return;
      setEth({ ...session, kind: "walletconnect" });
      setQr(null);
    } catch (caught) {
      const message = explain(caught);
      if (!/cancelled/i.test(message) && wcGen.current === gen) setError(message);
    } finally {
      if (wcGen.current === gen) {
        scanning.current = false;
        setConnecting(null);
        setQr(null);
      }
    }
  }

  const walletReady = isEthCluster(active) ? eth !== null : connected;
  const secondsLeft = view && now !== null && view.deadline > 0 ? view.deadline - Math.floor(now / 1000) : null;
  const timedOut = secondsLeft !== null && secondsLeft <= 0;
  const buyInClock = Boolean(view && view.phase === "waiting" && view.deadline > 0 && view.seats.every((seat) => seat.address));

  const home = networkHref(network);
  return (
    <>
      <header className="nav">
        <a className="brand" href={home}>
          <span className="mark">♠</span>
          <span>
            <strong>DeFi Casino</strong>
            <small>Blackjack</small>
          </span>
        </a>
        <nav className="nav-links" aria-label="Casino">
          <a href={home} aria-current={tableId ? undefined : "page"}>Play</a>
          <a href={`${home}#rules`}>Rules</a>
          <a href={`${home}#how`}>How it works</a>
        </nav>
        <div className="tools">
          <label className="cluster">
            <span>Network</span>
            <select
              value={network}
              onChange={(event) => {
                const next = event.target.value as ClusterName;
                setCluster(next);
                router.push(networkHref(next));
              }}
            >
              <option value="mainnet">Solana mainnet</option>
              <option value="ethereum">Ethereum mainnet</option>
              <option value="devnet">Solana devnet</option>
              <option value="localnet">Solana localnet</option>
              <option value="sepolia">Ethereum Sepolia</option>
            </select>
          </label>
          <span className="balance">{balance}</span>
          {isEthCluster(active) ? (
            eth ? (
              <>
                {active === "sepolia" ? <a className="texty linkish" href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noreferrer">Sepolia faucet</a> : null}
                <WalletMenu
                  chain="ethereum"
                  address={eth.account}
                  label={short(eth.account)}
                  onDisconnect={() => {
                    if (eth.kind === "walletconnect") void eth.provider.disconnect?.();
                    setEth(null);
                  }}
                />
              </>
            ) : (
              <>
                <button className="solid" type="button" disabled={connecting !== null} onClick={() => void connectMetaMask()}>
                  {connecting === "injected" ? "Connecting…" : "MetaMask"}
                </button>
                <button className="solid alt" type="button" disabled={connecting !== null} onClick={() => void connectCode()}>
                  {connecting === "walletconnect" ? "Waiting for scan…" : "WalletConnect"}
                </button>
              </>
            )
          ) : (
            <>
              {active === "devnet" ? <a className="texty linkish" href="https://faucet.solana.com" target="_blank" rel="noreferrer">Devnet faucet</a> : null}
              {connected && publicKey ? (
                <WalletMenu
                  chain="solana"
                  address={publicKey.toBase58()}
                  label={short(publicKey.toBase58())}
                  onChange={() => setVisible(true)}
                  onDisconnect={() => void disconnect()}
                />
              ) : (
                <button className="solid" type="button" onClick={() => setVisible(true)}>Select Wallet</button>
              )}
            </>
          )}
        </div>
      </header>
      <main className="page">
      <p className="hint">
        Connect your wallet, then approve the buy-in. Your private key stays in your wallet.
      </p>
      {qr ? (
        <div className="qr-panel">
          <img src={qr} alt="WalletConnect code" />
          <p className="hint">Scan with MetaMask or another Ethereum wallet, then approve the connection. Connecting does not send a transaction.</p>
          <button className="texty" type="button" onClick={() => { wcGen.current += 1; scanning.current = false; setQr(null); setConnecting(null); cancelWalletConnect(); }}>Cancel</button>
        </div>
      ) : null}
      {error ? <p className="banner bad" role="alert">{error}</p> : null}
      {notice ? <p className="banner good">{notice}</p> : null}
      {view && view.cluster !== network ? (
        <p className="banner bad">This table is on {networkLabel(view.cluster)}.</p>
      ) : null}

      {view ? (
        <>
        <section className="table-layout">
          <div className="felt around">
            <div className="seat-ring" data-seats={view.seats.length}>
              {view.seats.map((seat) => (
                <Hand
                  key={seat.index}
                  pos={seat.index}
                  title={`Player ${seat.index + 1}`}
                  who={seat.wallet || seat.address}
                  cards={seat.cards}
                  total={seat.out ? "Out" : handLabel(seat.cards, seat.faceDown)}
                  faceDown={seat.faceDown}
                  empty={!seat.address}
                  active={view.phase === "acting" && view.turn === seat.index}
                />
              ))}
              <div className="table-well">
                <div className="pot">
                  <span>Pot</span>
                  <strong>{money(view.cluster, view.pot)}</strong>
                  <small>{clockLabel(secondsLeft, timedOut, buyInClock)}</small>
                </div>
                <div className="actions">
                  <p className="status">{statusText(view, buyInClock, timedOut)}</p>
                  <div className="buttons">
                    {view.depositAddress ? (
                      <button className="solid" type="button" disabled={busy || !walletReady} onClick={() => void run(sendBuyIn)}>
                        {walletReady ? `Send ${money(view.cluster, view.due)}` : "Connect a wallet to fund"}
                      </button>
                    ) : null}
                    {view.phase === "waiting" && typeof view.yourSeat === "number" && view.seats.some((seat) => !seat.address) && view.seats.filter((seat) => seat.address).length >= 2 ? (
                      <button className="solid alt" type="button" disabled={busy} onClick={() => void run(() => act("vote"))}>
                        {view.seats[view.yourSeat]?.ready ? "Remove start vote" : "Vote to start now"}
                      </button>
                    ) : null}
                    {view.phase === "waiting" && (view.yourSeat === 0 || (typeof view.yourSeat === "number" && view.seats[view.yourSeat]?.funded && timedOut)) ? (
                      <button className="solid alt" type="button" disabled={busy} onClick={() => void run(() => act("cancel"))}>Cancel and refund</button>
                    ) : null}
                    {view.yourSeat === "spectator" && view.phase === "waiting" && view.seats.some((seat) => !seat.address) ? (
                      <button className="solid" type="button" disabled={busy || !walletReady} onClick={() => void run(joinTable)}>
                        {walletReady ? `Sit as player ${view.seats.findIndex((seat) => !seat.address) + 1}` : "Connect a wallet to sit"}
                      </button>
                    ) : null}
                    {view.phase === "acting" && view.yourSeat === view.turn ? (
                      <>
                        <button className="solid" type="button" disabled={busy || view.hitsLeft === 0} onClick={() => void run(() => act("hit"))}>Hit</button>
                        <button className="solid alt" type="button" disabled={busy} onClick={() => void run(() => act("stand"))}>Stand</button>
                      </>
                    ) : null}
                    {timedOut && view.phase === "acting" && typeof view.yourSeat === "number" && view.yourSeat !== view.turn ? (
                      <button className="solid" type="button" disabled={busy} onClick={() => void run(() => act("claim"))}>Claim the timeout</button>
                    ) : null}
                    {view.payoutError ? (
                      <button className="solid" type="button" disabled={busy} onClick={() => void run(() => act("payout"))}>Send the pot again</button>
                    ) : null}
                    {view.phase === "settled" || view.phase === "cancelled" ? (
                      <a className="solid alt linkish" href={networkHref(view.cluster)}>New table</a>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <aside className="side">
            <h2>Table</h2>
            <dl>
              <div><dt>You</dt><dd>{view.yourSeat === "spectator" ? "Watching" : `Player ${view.yourSeat + 1}`}</dd></div>
              {view.seats.map((seat) => (
                <div key={seat.index}><dt>Player {seat.index + 1}</dt><dd>{seat.wallet || seat.address ? <AddressChip value={seat.wallet || seat.address} /> : "Open"}</dd></div>
              ))}
              <div><dt>Buy-in</dt><dd>{money(view.cluster, view.stake)} each</dd></div>
              <div><dt>Funded</dt><dd>{view.seats.filter((seat) => seat.funded).map((seat) => `Player ${seat.index + 1}`).join(" · ") || "—"}</dd></div>
            </dl>
            <button className="solid alt" type="button" onClick={() => void navigator.clipboard.writeText(window.location.href).then(() => setNotice("Invite link copied.")).catch(() => setError("Could not copy the link."))}>
              Copy invite link
            </button>
            <p className="hint">The extra {money(view.cluster, view.buffer)} on the buy-in stays in the seat for fees. The server signs the payout. The other players' cards stay hidden until everyone has finished.</p>
            {view.payouts.length > 0 ? <p className="hint">Payout sent.</p> : null}
            {view.payoutError ? <p className="hint warn">{view.payoutError}</p> : null}
          </aside>
        </section>
        {tableId ? (
          <TableChat
            tableId={tableId}
            {...chatAccess(
              view.yourSeat,
              typeof view.yourSeat === "number" ? view.seats[view.yourSeat]?.wallet ?? "" : "",
              linkedAccount,
              profileChainOf(view.cluster),
            )}
            supabaseUrl={supabaseUrl}
            supabaseKey={supabaseKey}
          />
        ) : null}
        </>
      ) : tableId && !missing ? (
        <p className="boot">Looking up the table…</p>
      ) : waiting ? (
        <section className="lobby" id="play">
          <div className="panel">
            <h2>Looking for a match</h2>
            <p>Buy-in {money(waiting.cluster, waiting.stake)}. This is a {waiting.seats}-player table. The next wallets that want that stake and table size sit with you.</p>
            <p className="hint">{waiting.others > 0 ? `${waiting.others} other ${waiting.others === 1 ? "player is" : "players are"} waiting at this buy-in.` : "You are first in line."}</p>
            <p className="hint">{lobbyLine(lobby)}</p>
            <button className="texty" type="button" disabled={busy} onClick={() => void run(leaveMatch)}>Leave the line</button>
          </div>
        </section>
      ) : (
        <Lobby
          network={network}
          mode={mode}
          walletReady={walletReady}
          missing={missing}
          stake={stake}
          seats={seatCount}
          invite={invite}
          lobby={lobby}
          busy={busy}
          onMode={setMode}
          onStake={setStake}
          onSeats={setSeatCount}
          onInvite={setInvite}
          onCreate={() => void run(createTable)}
          onMatch={() => void run(findMatch)}
          mine={mine}
          onRejoin={(row) => void run(() => reopen(row))}
          onOpen={(value) => {
            const id = readTableId(value);
            if (!id) {
              setError("Paste a table link.");
              return;
            }
            const chain = value.includes("chain=") ? new URL(value, "http://localhost").searchParams.get("chain") : null;
            const cluster = chainFromUrl(chain) ?? network;
            void run(async () => {
              try {
                const body = await api<{ id: string; cluster: Cluster }>("/api/tables/mine", {
                  method: "POST",
                  headers: walletHeaders(),
                  body: JSON.stringify({ id }),
                });
                go(body.id, body.cluster);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "";
                if (/not yours|already over|not valid|No table/i.test(message)) {
                  go(id, cluster);
                  return;
                }
                throw caught;
              }
            });
          }}
        />
      )}
    </main>
    </>
  );
}

type MatchState =
  | { status: "idle" }
  | { status: "waiting"; stake: string; cluster: Cluster; others: number; seats: number }
  | { status: "matched"; table: TableView };

type CurrentTable = {
  id: string;
  cluster: Cluster;
  phase: "waiting" | "acting";
  stake: string;
  seat: number;
  seats: number;
  funded: boolean;
  turn: boolean;
};

function currentLine(row: CurrentTable, network: Cluster): { title: string; detail: string } {
  const where = row.phase === "acting" ? (row.turn ? "Your turn" : "Hand in play") : "Waiting";
  const paid = row.funded ? "Buy-in paid" : "Buy-in due";
  return {
    title: `Player ${row.seat + 1} of ${row.seats}`,
    detail: `${where} · ${paid} · ${money(network, row.stake)}`,
  };
}

function lobbyLine(lobby: LobbyCounts | null): string {
  if (!lobby) return "Checking who is here…";
  return `${lobby.waiting} waiting · ${lobby.playing} playing`;
}

function Lobby({
  network, mode, walletReady, missing, stake, seats, invite, lobby, mine, busy, onMode, onStake, onSeats, onInvite, onCreate, onMatch, onOpen, onRejoin,
}: {
  network: Cluster;
  mode: "invite" | "match";
  walletReady: boolean;
  missing: boolean;
  stake: string;
  seats: number;
  invite: string;
  lobby: LobbyCounts | null;
  mine: CurrentTable[] | null;
  busy: boolean;
  onMode: (mode: "invite" | "match") => void;
  onStake: (value: string) => void;
  onSeats: (value: number) => void;
  onInvite: (value: string) => void;
  onCreate: () => void;
  onMatch: () => void;
  onOpen: (value: string) => void;
  onRejoin: (row: CurrentTable) => void;
}) {
  const [link, setLink] = useState("");
  const unit = isEthCluster(network) ? "ETH" : "SOL";
  return (
    <section className="lobby" id="play">
      <div className="intro">
        <p className="eyebrow">Up to seven players, one hand</p>
        <h1>DeFi Casino</h1>
        <p className="subtext">Blackjack</p>
        <p>
          Play friends, or get matched with people who want the same buy-in.
          Everyone puts in the same amount, then hits or stands in seat order. You only see your own cards until the hand is over.
          Closest to 21 takes the pot. A tie splits it.
        </p>
        <p className="lobby-count">{lobbyLine(lobby)}</p>
      </div>
      <div className="buttons">
        <button className={mode === "invite" ? "solid" : "texty"} type="button" onClick={() => onMode("invite")}>Invite a friend</button>
        <button className={mode === "match" ? "solid" : "texty"} type="button" onClick={() => onMode("match")}>Find a match</button>
      </div>
      <div className="panels">
        <form className="panel" onSubmit={(event) => { event.preventDefault(); if (mode === "match") onMatch(); else onCreate(); }}>
          <h2>{mode === "match" ? "Find a match" : "Open a table"}</h2>
          <div className="field">
            <span>Buy-in ({unit})</span>
            <div className="stakes" role="group" aria-label={`Buy-in in ${unit}`}>
              {STAKE_CHIPS.map((chip) => {
                const count = lobby?.stakes[String(seats)]?.[chip] ?? 0;
                return (
                  <button
                    key={chip}
                    className={stake === chip ? "stake on" : "stake"}
                    type="button"
                    aria-pressed={stake === chip}
                    aria-label={`${chip} ${unit}, ${count} waiting for ${seats} players`}
                    onClick={() => onStake(chip)}
                  >
                    <span>{chip}</span>
                    <small>{count}</small>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="field">
            <span>Players</span>
            <div className="stakes" role="group" aria-label="Number of players">
              {[2, 3, 4, 5, 6, 7].map((count) => (
                <button
                  key={count}
                  className={seats === count ? "stake on" : "stake"}
                  type="button"
                  aria-pressed={seats === count}
                  onClick={() => onSeats(count)}
                >
                  <span>{count}</span>
                </button>
              ))}
            </div>
          </div>
          {mode === "invite" ? (
            <label>
              Reserve the next seat
              <input value={invite} onChange={(event) => onInvite(event.target.value)} placeholder="Optional wallet address" spellCheck={false} />
            </label>
          ) : null}
          <button className="solid" type="submit" disabled={busy || (mode === "match" && !walletReady)}>
            {mode === "match" ? (walletReady ? "Find a match" : "Connect a wallet to match") : "Create the table"}
          </button>
          <p className="hint">
            {mode === "match"
              ? `You wait until ${seats - 1} more ${seats - 1 === 1 ? "wallet wants" : "wallets want"} this buy-in and a ${seats}-player table. The oldest wallet is player 1. Nothing is sent until you fund the seat.`
              : "Creating a table does not move funds. You send the buy-in afterward, from your own wallet, to a seat key that stays on the server. The hand starts when every seat has paid."}
          </p>
        </form>
        <div className="panel">
          <h2>Sit at a table</h2>
          <form onSubmit={(event) => { event.preventDefault(); onOpen(link); }}>
            <h3>Join a table</h3>
            <label>
              Invite link
              <input value={link} onChange={(event) => setLink(event.target.value)} placeholder="Paste a link" spellCheck={false} />
            </label>
            <button className="solid alt" type="submit" disabled={busy || link.trim().length === 0}>Open table</button>
            {missing ? <p className="hint">No table is using that link.</p> : null}
          </form>
          <section className="current-tables" aria-labelledby="current-tables-heading">
            <h3 id="current-tables-heading">Current tables</h3>
            {mine === null ? <p className="hint">Checking your tables…</p> : mine.length === 0 ? (
              <p className="hint">{walletReady ? "No table is still waiting or in a hand." : "Connect a wallet to return to a table you left."}</p>
            ) : (
              <ul className="current-list">
                {mine.map((row) => {
                  const line = currentLine(row, network);
                  return (
                    <li key={row.id}>
                      <button className="texty current-row" type="button" disabled={busy} onClick={() => onRejoin(row)}>
                        <span>{line.title}</span>
                        <small>{line.detail}</small>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
      <div className="rules-grid">
        <article className="rules" id="rules">
          <h2>Rules</h2>
          <ul>
            <li>Two to seven players, one hand. There is no dealer. A full table has seven seats.</li>
            <li>Aces are 1 or 11. Face cards are 10. Every other card is its number.</li>
            <li>Each player is dealt two cards and can see only that hand. Cards go around the table, one at a time.</li>
            <li>Player 1 hits or stands first. Play continues in seat order. Nobody sees the other hands yet.</li>
            <li>Hit draws one card. After 6 hits the hand must stand. A total of 21 ends that player's choices.</li>
            <li>Over 21 is a bust. A bust loses to a finished hand of 21 or less.</li>
            <li>The highest total takes the pot. Players who tie for that total split it. If every hand busts, each buy-in comes back.</li>
            <li>A two-card 21 pays the same as any other 21.</li>
          </ul>
        </article>
        <article className="rules" id="how">
          <h2>How a table works</h2>
          <ol>
            <li>Choose 2 to 7 seats. Invite friends, or wait for wallets that pick the same buy-in and the same table size. The oldest wallet is player 1. A wait lasts 15 minutes. If at least two people have sat and seats are still open, everyone sitting can vote to start now. The open seats close, then the buy-in clock starts.</li>
            <li>On Solana mainnet and Ethereum mainnet, a wallet must already hold the buy-in before it sits or enters the queue. On a table of three or more, a player who has paid can type /kick and a name in the chat. The named player must not have paid. When a majority of the paid players agree, and more than two have paid, that seat opens.</li>
            <li>Opening a table does not move funds. Each player then sends the buy-in from their own wallet to the seat address on the table. Once every seat is taken, everyone has 5 minutes to buy in. The deal starts when every seat has paid.</li>
            <li>The transfer includes a fee reserve, 0.02 SOL or 0.002 ETH. That extra stays in the seat for the network fee. Your wallet key never goes to the server.</li>
            <li>The server shuffles one deck and deals. The shoe and the other players' cards stay on the server until every player has finished.</li>
            <li>The pot is paid from every seat. A split divides it. A push returns each buy-in. Player 1 can cancel before the deal, and a funded buy-in comes back. If the table has not filled 15 minutes after the first buy-in, any funded player can cancel. Once every seat is taken, that wait becomes a 5 minute buy-in clock, and any funded player can cancel after it runs out.</li>
            <li>Each turn lasts 10 minutes. If that player stops, another player can claim the timeout. That seat is out, and the hand continues. Leaving the page drops the lobby count and does not forfeit a funded hand. Sit at a table lists a hand that is still waiting or in play, so you can open it again.</li>
            <li>Solana mainnet and Ethereum mainnet move real funds. Devnet, localnet, and Sepolia do not.</li>
            <li>One wallet cannot take two seats. A listed sanctions address, or a wallet that has transacted with one, is refused.</li>
          </ol>
        </article>
      </div>
    </section>
  );
}

function handLabel(cards: number[], faceDown: number): string {
  if (faceDown > 0 || cards.length === 0) return "—";
  return String(handTotal(cards));
}

function Hand({ title, who = "", cards, total, faceDown = 0, empty = false, active = false, pos }: {
  title: string;
  who?: string;
  cards: number[];
  total: string;
  faceDown?: number;
  empty?: boolean;
  active?: boolean;
  pos: number;
}) {
  const backs = empty ? 0 : cards.length === 0 && faceDown === 0 ? 2 : faceDown;
  const shown = cards.length + backs;
  const className = ["seat", empty ? "empty" : "", active ? "turn" : ""].filter(Boolean).join(" ");
  return (
    <section className={className} data-pos={pos}>
      <header>
        <div className="seat-name">
          <h2>{title}</h2>
          {who ? <AddressChip value={who} /> : null}
        </div>
        <span className={empty ? "open-seat" : undefined}>{empty ? "Open" : total}</span>
      </header>
      {empty ? null : (
        <div className="cards" style={{ "--n": String(shown) } as CSSProperties}>
          {cards.map((card, index) => <PlayingCard key={`${card}-${index}`} card={card} />)}
          {Array.from({ length: backs }, (_, index) => <PlayingCard key={`down-${index}`} faceDown />)}
        </div>
      )}
    </section>
  );
}

function statusText(view: TableView, buyInClock: boolean, timedOut: boolean): string {
  if (view.phase === "cancelled") return "Cancelled. Funded buy-ins are sent back.";
  if (view.phase === "waiting") {
    const open = view.seats.filter((seat) => !seat.address).length;
    const vote = startVoteText(view);
    if (open === 1) return vote ? `Waiting for another player. ${vote}` : "Waiting for another player.";
    if (open > 1) return vote ? `Waiting for ${open} more players. ${vote}` : `Waiting for ${open} more players.`;
    if (buyInClock && timedOut) return "The buy-in time is up. A funded player can cancel.";
    if (buyInClock) return "Every seat is taken. Send the buy-in before the clock runs out.";
    return "Waiting for every buy-in.";
  }
  if (view.phase === "acting") {
    if (view.yourSeat === view.turn) return "Your turn. Hit or stand.";
    return `Player ${view.turn + 1} is choosing.`;
  }
  if (view.winners.length === 0) return "Push. Every buy-in is returned.";
  if (view.winners.length === 1) return `Player ${view.winners[0]! + 1} wins the pot.`;
  return `${view.winners.map((index) => `Player ${index + 1}`).join(" and ")} split the pot.`;
}

function startVoteText(view: TableView): string {
  const seated = view.seats.filter((seat) => seat.address);
  if (view.phase !== "waiting" || seated.length < 2 || seated.length === view.seats.length) return "";
  const votes = seated.filter((seat) => seat.ready).length;
  return `${votes} of ${seated.length} voted to start now.`;
}

function clockLabel(secondsLeft: number | null, timedOut: boolean, buyInClock: boolean): string {
  if (secondsLeft === null) return "No clock yet";
  if (buyInClock) return timedOut ? "Buy-in time is up" : `${formatClock(secondsLeft)} to buy in`;
  return timedOut ? "Timed out" : `${formatClock(secondsLeft)} left`;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function readTableId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const raw = trimmed.includes("table=")
    ? new URL(trimmed, "http://localhost").searchParams.get("table") ?? ""
    : trimmed;
  return /^[A-Za-z0-9_-]{8,32}$/.test(raw) ? raw : null;
}
