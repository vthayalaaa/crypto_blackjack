"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createWalletClient, custom, type Address } from "viem";
import { mainnet, sepolia } from "viem/chains";
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
import { isEthCluster, networkHref, networkLabel, type Cluster, type TableView } from "../lib/table-view";
import { WALLETCONNECT_PROJECT_ID, useCluster, type ClusterName } from "./Providers";
import { PlayingCard } from "./PlayingCard";

type EthSession = { provider: EthProvider; account: Address; kind: "injected" | "walletconnect" };

function money(cluster: Cluster, amount: string): string {
  if (!amount) return "—";
  return isEthCluster(cluster) ? `${formatEth(BigInt(amount))} ETH` : `${formatSol(BigInt(amount))} SOL`;
}

function short(value: string): string {
  if (!value) return "—";
  return value.startsWith("0x") ? shortAddress(value) : value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
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

export function HouseTable({ network }: { network: Cluster }) {
  const params = useSearchParams();
  const tableId = params.get("table");
  const router = useRouter();
  const { setCluster } = useCluster();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [stake, setStake] = useState("0.05");
  const [invite, setInvite] = useState("");
  const [mode, setMode] = useState<"invite" | "match">("invite");
  const [waiting, setWaiting] = useState<{ stake: string; cluster: Cluster; others: number } | null>(null);
  const [lobby, setLobby] = useState<LobbyCounts | null>(null);
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

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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
        setWaiting(body.status === "waiting" ? { stake: body.stake, cluster: body.cluster, others: body.others } : null);
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

  async function createTable() {
    const body = await api<{ table: TableView }>("/api/tables", {
      method: "POST",
      body: JSON.stringify({ cluster: network, stake, invite, wallet: walletRef.current }),
    });
    go(body.table.id, body.table.cluster);
  }

  async function findMatch() {
    const wallet = isEthCluster(network) ? eth?.account : publicKey?.toBase58();
    if (!wallet) throw new Error("Connect a wallet first.");
    const body = await api<MatchState>("/api/match", {
      method: "POST",
      body: JSON.stringify({ cluster: network, stake, wallet }),
    });
    if (body.status === "matched") {
      setWaiting(null);
      go(body.table.id, body.table.cluster);
      return;
    }
    if (body.status === "waiting") setWaiting({ stake: body.stake, cluster: body.cluster, others: body.others });
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
    await api(`/api/tables/${tableId}/join`, { method: "POST", body: JSON.stringify({ wallet }) });
    setNotice("You have player 2. Send the same buy-in.");
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

  async function act(action: "hit" | "stand" | "cancel" | "claim" | "payout") {
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

  return (
    <main className="page">
      <header className="top">
        <a className="brand" href={networkHref(network)}>
          <span className="mark">♠</span>
          <span>
            <strong>Decentralized Blackjack</strong>
            <small>Solana and Ethereum</small>
          </span>
        </a>
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
              <option value="devnet">Solana devnet</option>
              <option value="mainnet">Solana mainnet</option>
              <option value="localnet">Solana localnet</option>
              <option value="sepolia">Ethereum Sepolia</option>
              <option value="ethereum">Ethereum mainnet</option>
            </select>
          </label>
          <span className="balance">{balance}</span>
          {isEthCluster(active) ? (
            eth ? (
              <>
                <span className="balance">{short(eth.account)}</span>
                {active === "sepolia" ? <a className="texty linkish" href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noreferrer">Sepolia faucet</a> : null}
                <button className="texty" type="button" onClick={() => {
                  if (eth.kind === "walletconnect") void eth.provider.disconnect?.();
                  setEth(null);
                }}>Disconnect</button>
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
              <WalletMultiButton />
            </>
          )}
        </div>
      </header>
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
      {active === "mainnet" || active === "ethereum" ? (
        <p className="banner bad" role="status">{networkLabel(active)} uses real {active === "mainnet" ? "SOL" : "ETH"}. Set the wallet to that network before you approve. A buy-in cannot be undone.</p>
      ) : null}
      {view && view.cluster !== network ? (
        <p className="banner bad">This table is on {networkLabel(view.cluster)}.</p>
      ) : null}

      {view ? (
        <section className="table-layout">
          <div className="felt">
            <Hand
              title={view.dealerSeat ? `Player 2 · ${short(view.dealerWallet || view.dealerSeat)}` : "Player 2"}
              cards={view.dealerCards}
              total={handLabel(view.dealerCards, view.dealerFaceDown)}
              faceDown={view.dealerFaceDown}
            />
            <div className="pot">
              <span>Pot</span>
              <strong>{money(view.cluster, view.pot)}</strong>
              <small>{secondsLeft === null ? "No clock yet" : timedOut ? "Timed out" : `${formatClock(secondsLeft)} left`}</small>
            </div>
            <Hand
              title={view.playerSeat ? `Player 1 · ${short(view.playerWallet || view.playerSeat)}` : "Player 1"}
              cards={view.playerCards}
              total={handLabel(view.playerCards, view.playerFaceDown)}
              faceDown={view.playerFaceDown}
            />
            <div className="actions">
              <p className="status">{statusText(view)}</p>
              <div className="buttons">
                {view.depositAddress ? (
                  <button className="solid" type="button" disabled={busy || !walletReady} onClick={() => void run(sendBuyIn)}>
                    {walletReady ? `Send ${money(view.cluster, view.due)}` : "Connect a wallet to fund"}
                  </button>
                ) : null}
                {view.yourSeat === "player" && view.phase === "waiting" ? (
                  <button className="solid alt" type="button" disabled={busy} onClick={() => void run(() => act("cancel"))}>Cancel and refund</button>
                ) : null}
                {view.yourSeat === "spectator" && view.phase === "waiting" && !view.dealerSeat ? (
                  <button className="solid" type="button" disabled={busy || !walletReady} onClick={() => void run(joinTable)}>
                    {walletReady ? "Sit as player 2" : "Connect a wallet to sit"}
                  </button>
                ) : null}
                {((view.yourSeat === "player" && view.phase === "player") || (view.yourSeat === "dealer" && view.phase === "second")) ? (
                  <>
                    <button className="solid" type="button" disabled={busy || view.hitsLeft === 0} onClick={() => void run(() => act("hit"))}>Hit</button>
                    <button className="solid alt" type="button" disabled={busy} onClick={() => void run(() => act("stand"))}>Stand</button>
                  </>
                ) : null}
                {timedOut && ((view.yourSeat === "dealer" && view.phase === "player") || (view.yourSeat === "player" && view.phase === "second")) ? (
                  <button className="solid" type="button" disabled={busy} onClick={() => void run(() => act("claim"))}>Claim the pot</button>
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
          <aside className="side">
            <h2>Table</h2>
            <dl>
              <div><dt>You</dt><dd>{view.yourSeat === "spectator" ? "Watching" : view.yourSeat === "player" ? "Player 1" : "Player 2"}</dd></div>
              <div><dt>Player 1 seat</dt><dd>{short(view.playerSeat)}</dd></div>
              <div><dt>Player 2 seat</dt><dd>{view.dealerSeat ? short(view.dealerSeat) : "Open"}</dd></div>
              <div><dt>Buy-in</dt><dd>{money(view.cluster, view.stake)} each</dd></div>
              <div><dt>Funded</dt><dd>{view.playerFunded ? "Player 1" : "—"}{view.dealerFunded ? " · Player 2" : ""}</dd></div>
            </dl>
            <button className="solid alt" type="button" onClick={() => void navigator.clipboard.writeText(window.location.href).then(() => setNotice("Invite link copied.")).catch(() => setError("Could not copy the link."))}>
              Copy invite link
            </button>
            <p className="hint">The extra {money(view.cluster, view.buffer)} on the buy-in stays in the seat for fees. The server signs the payout. The other player's cards stay hidden until both players have finished.</p>
            {view.payouts.length > 0 ? <p className="hint">Payout sent.</p> : null}
            {view.payoutError ? <p className="hint warn">{view.payoutError}</p> : null}
          </aside>
        </section>
      ) : tableId && !missing ? (
        <p className="boot">Looking up the table…</p>
      ) : waiting ? (
        <section className="lobby">
          <div className="panel">
            <h2>Looking for a match</h2>
            <p>Buy-in {money(waiting.cluster, waiting.stake)}. The next person who wants that stake on this network sits with you.</p>
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
          invite={invite}
          lobby={lobby}
          busy={busy}
          onMode={setMode}
          onStake={setStake}
          onInvite={setInvite}
          onCreate={() => void run(createTable)}
          onMatch={() => void run(findMatch)}
          onOpen={(value) => {
            const id = readTableId(value);
            if (!id) {
              setError("Paste a table link.");
              return;
            }
            const chain = value.includes("chain=") ? new URL(value, "http://localhost").searchParams.get("chain") : null;
            const cluster = chain === "localnet" || chain === "mainnet" || chain === "sepolia" || chain === "ethereum" ? chain : network;
            go(id, cluster);
          }}
        />
      )}
    </main>
  );
}

type MatchState =
  | { status: "idle" }
  | { status: "waiting"; stake: string; cluster: Cluster; others: number }
  | { status: "matched"; table: TableView };

function lobbyLine(lobby: LobbyCounts | null): string {
  if (!lobby) return "Checking who is here…";
  return `${lobby.waiting} waiting · ${lobby.playing} playing`;
}

function Lobby({
  network, mode, walletReady, missing, stake, invite, lobby, busy, onMode, onStake, onInvite, onCreate, onMatch, onOpen,
}: {
  network: Cluster;
  mode: "invite" | "match";
  walletReady: boolean;
  missing: boolean;
  stake: string;
  invite: string;
  lobby: LobbyCounts | null;
  busy: boolean;
  onMode: (mode: "invite" | "match") => void;
  onStake: (value: string) => void;
  onInvite: (value: string) => void;
  onCreate: () => void;
  onMatch: () => void;
  onOpen: (value: string) => void;
}) {
  const [link, setLink] = useState("");
  const unit = isEthCluster(network) ? "ETH" : "SOL";
  return (
    <section className="lobby">
      <div className="intro">
        <p className="eyebrow">Two players, one hand</p>
        <h1>Decentralized Blackjack</h1>
        <p>
          Play a friend, or get matched with someone who wants the same buy-in.
          You each put in the same amount, then hit or stand. You only see your own cards until the hand is over.
          Closest to 21 takes the pot. A tie pays you both back.
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
                const count = lobby?.stakes[chip] ?? 0;
                return (
                  <button
                    key={chip}
                    className={stake === chip ? "stake on" : "stake"}
                    type="button"
                    aria-pressed={stake === chip}
                    aria-label={`${chip} ${unit}, ${count} waiting`}
                    onClick={() => onStake(chip)}
                  >
                    <span>{chip}</span>
                    <small>{count}</small>
                  </button>
                );
              })}
            </div>
          </div>
          {mode === "invite" ? (
            <label>
              Reserve player 2
              <input value={invite} onChange={(event) => onInvite(event.target.value)} placeholder="Optional wallet address" spellCheck={false} />
            </label>
          ) : null}
          <button className="solid" type="submit" disabled={busy || (mode === "match" && !walletReady)}>
            {mode === "match" ? (walletReady ? "Find a match" : "Connect a wallet to match") : "Create the table"}
          </button>
          <p className="hint">
            {mode === "match"
              ? "You wait until another wallet wants this same buy-in on this network. The first person in line is player 1. The second is player 2. Nothing is sent until you fund the seat."
              : "Creating a table does not move funds. You send the buy-in afterward, from your own wallet, to a seat key that stays on the server."}
          </p>
        </form>
        <form className="panel" onSubmit={(event) => { event.preventDefault(); onOpen(link); }}>
          <h2>Sit at a table</h2>
          <label>
            Invite link
            <input value={link} onChange={(event) => setLink(event.target.value)} placeholder="Paste a link" spellCheck={false} />
          </label>
          <button className="solid alt" type="submit" disabled={busy || link.trim().length === 0}>Open table</button>
          {missing ? <p className="hint">No table is using that link.</p> : null}
        </form>
      </div>
      <div className="rules-grid">
        <article className="rules">
          <h2>Rules</h2>
          <ul>
            <li>Two players, one hand. There is no dealer.</li>
            <li>Aces are 1 or 11. Face cards are 10. Every other card is its number.</li>
            <li>Each player is dealt two cards and can see only that hand.</li>
            <li>Player 1 hits or stands first. Player 2 goes next, still without seeing player 1.</li>
            <li>Hit draws one card. After 6 hits the hand must stand. A total of 21 ends that player's choices.</li>
            <li>Over 21 is a bust. A bust loses to a finished hand of 21 or less.</li>
            <li>The higher total takes the pot. Equal totals, or two busts, send both buy-ins back.</li>
            <li>A two-card 21 pays the same as any other 21.</li>
          </ul>
        </article>
        <article className="rules">
          <h2>How a table works</h2>
          <ol>
            <li>Invite a friend, or wait for someone who picks the same buy-in. The first wallet is player 1. The second is player 2. A wait lasts 15 minutes.</li>
            <li>Opening a table does not move funds. Each player then sends the buy-in from their own wallet to the seat address on the table.</li>
            <li>The transfer includes a fee reserve, 0.02 SOL or 0.002 ETH. That extra stays in the seat for the network fee. Your wallet key never goes to the server.</li>
            <li>The server shuffles one deck and deals. The shoe and the other player's cards stay on the server until both players have finished.</li>
            <li>The winner is paid from both seats. A push returns each buy-in. Player 1 can cancel before the deal, and a funded buy-in comes back.</li>
            <li>Each turn lasts 10 minutes. If that player stops, the other player can claim the pot. Leaving the page drops the lobby count and does not forfeit a funded hand.</li>
            <li>Solana mainnet and Ethereum mainnet move real funds. Devnet, localnet, and Sepolia do not.</li>
            <li>One wallet cannot take both seats. A listed sanctions address, or a wallet that has transacted with one, is refused.</li>
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

function Hand({ title, cards, total, faceDown = 0 }: { title: string; cards: number[]; total: string; faceDown?: number }) {
  const backs = cards.length === 0 && faceDown === 0 ? 2 : faceDown;
  return (
    <section className="hand">
      <header>
        <h2>{title}</h2>
        <span>{total}</span>
      </header>
      <div className="cards">
        {cards.map((card, index) => <PlayingCard key={`${card}-${index}`} card={card} />)}
        {Array.from({ length: backs }, (_, index) => <PlayingCard key={`down-${index}`} faceDown />)}
      </div>
    </section>
  );
}

function statusText(view: TableView): string {
  if (view.phase === "cancelled") return "Cancelled. Funded buy-ins are sent back.";
  if (view.phase === "waiting") return view.dealerSeat ? "Waiting for both buy-ins." : "Waiting for player 2.";
  if (view.phase === "player" || view.phase === "second") {
    const actor = view.phase === "player" ? "player" : "dealer";
    if (view.yourSeat === actor) return "Your turn. Hit or stand.";
    return view.phase === "player" ? "Player 1 is choosing." : "Player 2 is choosing.";
  }
  if (view.outcome === 1) return "Player 1 wins the pot.";
  if (view.outcome === 2) return "Player 2 wins the pot.";
  if (view.outcome === 3) return "Push. Both buy-ins are returned.";
  return "The hand is settled.";
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
