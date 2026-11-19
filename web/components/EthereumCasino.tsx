"use client";

import { isAddress, zeroAddress, type Address } from "viem";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { handTotal } from "../lib/cards";
import {
  BLACKJACK_ADDRESS,
  SEPOLIA_ID,
  type EthProvider,
  type EthTable,
  cancelWalletConnect,
  commitsOf,
  connectInjected,
  connectWalletConnect,
  createdTableId,
  formatEth,
  hitSeed,
  openingSeeds,
  parseEth,
  publicClient,
  readTable,
  shortAddress,
  showdownSeeds,
  writeGame,
} from "../lib/eth";
import { STATUS } from "../lib/layout";
import { loadSecrets, moveSecrets, shoeFor } from "../lib/secrets";
import { WALLETCONNECT_PROJECT_ID, useCluster, type ClusterName } from "./Providers";
import { PlayingCard } from "./PlayingCard";

type Seat = "player" | "dealer" | "spectator";
type Kind = "injected" | "walletconnect";
type Session = { provider: EthProvider; account: Address; kind: Kind };

function explain(error: unknown): string {
  const short = typeof error === "object" && error && "shortMessage" in error && typeof error.shortMessage === "string"
    ? error.shortMessage
    : error instanceof Error
      ? error.message
      : String(error);
  if (/user rejected|rejected the request|denied transaction|4001/i.test(short)) return "The wallet closed the request.";
  if (/insufficient funds/i.test(short)) return "This wallet does not have enough Sepolia ETH for the buy-in and the fee.";
  if (/cancelled/i.test(short)) return "WalletConnect was cancelled.";
  if (short.length > 280) return `${short.slice(0, 280)}…`;
  return short;
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function seatOf(game: EthTable, wallet: string | null): Seat {
  if (!wallet) return "spectator";
  if (same(wallet, game.player)) return "player";
  if (game.dealer !== zeroAddress && same(wallet, game.dealer)) return "dealer";
  return "spectator";
}

function resultText(game: EthTable): string {
  if (game.outcome === 1) return `${shortAddress(game.player)} wins the pot.`;
  if (game.outcome === 2) return `${shortAddress(game.dealer)} wins the pot.`;
  if (game.outcome === 3) return "Push. Both buy-ins are returned.";
  return "The hand is settled.";
}

function tableIdOf(value: string | null): bigint | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  return BigInt(value);
}

export function EthereumCasino() {
  const params = useSearchParams();
  const tableRaw = params.get("table");
  const tableId = tableIdOf(tableRaw);
  const router = useRouter();
  const { setCluster } = useCluster();
  const [stake, setStake] = useState("0.05");
  const [invite, setInvite] = useState("");
  const [game, setGame] = useState<EthTable | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [wallet, setWallet] = useState<Session | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<Kind | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [hasSecrets, setHasSecrets] = useState<boolean | null>(null);
  const wcGen = useRef(0);
  const scanning = useRef(false);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setLoaded(false);
    setGame(null);
  }, [tableRaw]);

  useEffect(() => {
    if (!tableId || !BLACKJACK_ADDRESS) return;
    let cancelled = false;
    const tick = () => {
      void readTable(tableId).then((next) => {
        if (cancelled) return;
        setGame(next);
        setLoaded(true);
      }).catch((caught) => {
        if (cancelled) return;
        setLoaded(true);
        setError(explain(caught));
      });
    };
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tableId]);

  useEffect(() => {
    if (!wallet) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    void publicClient.getBalance({ address: wallet.account }).then((value) => {
      if (!cancelled) setBalance(value);
    }).catch((caught) => {
      if (!cancelled) setError(explain(caught));
    });
    return () => {
      cancelled = true;
    };
  }, [wallet, game]);

  useEffect(() => {
    if (!wallet) return;
    const onChain = (chainId: unknown) => {
      const parsed = typeof chainId === "string" ? Number.parseInt(chainId, 16) : Number(chainId);
      setError(parsed === SEPOLIA_ID ? null : "Switch the wallet to Ethereum Sepolia. This table does not use mainnet.");
    };
    const onAccounts = (accounts: unknown) => {
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        setWallet(null);
        return;
      }
      const next = accounts[0] as Address;
      setWallet((current) => current ? { ...current, account: next } : current);
    };
    wallet.provider.on?.("chainChanged", onChain);
    wallet.provider.on?.("accountsChanged", onAccounts);
    return () => {
      wallet.provider.removeListener?.("chainChanged", onChain);
      wallet.provider.removeListener?.("accountsChanged", onAccounts);
    };
  }, [wallet]);

  useEffect(() => () => {
    if (scanning.current) cancelWalletConnect();
  }, []);

  async function connectMetaMask() {
    setConnecting("injected");
    setError(null);
    setNotice(null);
    try {
      const session = await connectInjected();
      setWallet({ ...session, kind: "injected" });
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
    setNotice(null);
    try {
      const session = await connectWalletConnect(WALLETCONNECT_PROJECT_ID, (uri) => {
        if (wcGen.current !== gen) return;
        void import("qrcode").then(async (QR) => {
          const url = await QR.toDataURL(uri, { margin: 1, width: 280 });
          if (wcGen.current === gen) setQr(url);
        });
      });
      if (wcGen.current !== gen) return;
      setWallet({ ...session, kind: "walletconnect" });
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

  function cancelCode() {
    wcGen.current += 1;
    scanning.current = false;
    setQr(null);
    setConnecting(null);
    cancelWalletConnect();
  }

  async function disconnect() {
    if (wallet?.kind === "walletconnect") {
      await wallet.provider.disconnect?.().catch(() => undefined);
    }
    setWallet(null);
    setBalance(null);
    setQr(null);
  }

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
      if (wallet) setBalance(await publicClient.getBalance({ address: wallet.account }));
      if (tableId && BLACKJACK_ADDRESS) {
        const next = await readTable(tableId);
        setGame(next);
        setLoaded(true);
      }
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  }

  async function send<name extends Parameters<typeof writeGame>[2]>(
    functionName: name,
    args: Parameters<typeof writeGame<name>>[3],
    value?: bigint,
  ) {
    if (!wallet) throw new Error("Connect a wallet first.");
    const hash = await writeGame(wallet.provider, wallet.account, functionName, args, value);
    await publicClient.waitForTransactionReceipt({ hash });
    setNotice("Confirmed.");
  }

  async function createTable() {
    if (!wallet) throw new Error("Connect a wallet first.");
    if (!BLACKJACK_ADDRESS) throw new Error("The Ethereum contract is not deployed yet.");
    const wei = parseEth(stake);
    const reserved = invite.trim();
    const inviteAddress = reserved.length === 0 ? zeroAddress : reserved;
    if (!isAddress(inviteAddress)) throw new Error("That invite is not an Ethereum address.");
    const owner = wallet.account.toLowerCase();
    const pending = `eth-pending:${owner}`;
    const shoe = await shoeFor(pending, owner, "player");
    const hash = await writeGame(
      wallet.provider,
      wallet.account,
      "createGame",
      [wei, inviteAddress, commitsOf(shoe.commits)],
      wei,
    );
    const id = await createdTableId(hash);
    moveSecrets(pending, id.toString(), "player");
    setNotice("Confirmed.");
    router.push(`/?chain=sepolia&table=${id.toString()}`);
  }

  async function joinTable() {
    if (!wallet || !game || !tableRaw || !tableId) throw new Error("Connect a wallet first.");
    const shoe = await shoeFor(tableRaw, wallet.account.toLowerCase(), "dealer");
    await send("joinGame", [tableId, commitsOf(shoe.commits)], game.stake);
  }

  async function withSeeds(role: "player" | "dealer"): Promise<Uint8Array[]> {
    if (!wallet || !tableRaw) throw new Error("Connect the wallet that sat at this table.");
    const owner = wallet.account.toLowerCase();
    const saved = loadSecrets(tableRaw, role);
    if (!saved || saved.owner.toLowerCase() !== owner || saved.role !== role) {
      throw new Error("This browser does not have the card secrets for your seat. Open the browser you used to sit down.");
    }
    return (await shoeFor(tableRaw, owner, role)).seeds;
  }

  const account = wallet?.account ?? null;
  const seat: Seat = game ? seatOf(game, account) : "spectator";
  const secondsLeft = game && now !== null && game.deadline > 0n
    ? Number(game.deadline - BigInt(Math.floor(now / 1000)))
    : null;
  const timedOut = secondsLeft !== null && secondsLeft <= 0 && game !== null && game.status !== 0 && game.status !== 8;
  const playerClaims = timedOut && !!game && [1, 4, 6].includes(game.status);
  const dealerClaims = timedOut && !!game && [2, 3, 5, 7].includes(game.status);

  useEffect(() => {
    if (!tableRaw || !account || seat === "spectator") {
      setHasSecrets(null);
      return;
    }
    const saved = loadSecrets(tableRaw, seat);
    setHasSecrets(!!saved && saved.owner.toLowerCase() === account.toLowerCase() && saved.role === seat);
  }, [tableRaw, account, seat, game?.status]);

  const badTable = tableRaw !== null && tableId === null;

  return (
    <main className="page">
      <header className="top">
        <a className="brand" href="/?chain=sepolia">
          <span className="mark">♠</span>
          <span>
            <strong>Blackjack</strong>
            <small>Solana and Ethereum</small>
          </span>
        </a>
        <div className="tools">
          <label className="cluster">
            <span>Network</span>
            <select
              value="sepolia"
              onChange={(event) => {
                const next = event.target.value as ClusterName;
                if (next === "sepolia") return;
                setCluster(next);
                router.push("/");
              }}
            >
              <option value="devnet">Solana devnet</option>
              <option value="localnet">Solana localnet</option>
              <option value="sepolia">Ethereum Sepolia</option>
            </select>
          </label>
          <span className="balance">
            {account ? shortAddress(account) : "—"}
            {" · "}
            {balance === null ? "—" : `${formatEth(balance)} ETH`}
          </span>
          {wallet ? (
            <a className="texty linkish" href="https://www.alchemy.com/faucets/ethereum-sepolia" target="_blank" rel="noreferrer">
              Sepolia faucet
            </a>
          ) : null}
          {wallet ? (
            <button className="texty" type="button" onClick={() => void disconnect()}>Disconnect</button>
          ) : (
            <>
              <button className="solid" type="button" disabled={connecting !== null} onClick={() => void connectMetaMask()}>
                {connecting === "injected" ? "Connecting…" : "MetaMask"}
              </button>
              <button className="solid alt" type="button" disabled={connecting !== null} onClick={() => void connectCode()}>
                {connecting === "walletconnect" ? "Waiting for scan…" : "WalletConnect"}
              </button>
            </>
          )}
        </div>
      </header>
      <p className="hint">
        This table uses Ethereum Sepolia. A wallet on mainnet is asked to switch before any transaction. If it refuses, nothing is sent.
        {BLACKJACK_ADDRESS
          ? ""
          : " The contract is not deployed yet. You can connect a wallet and see its balance. Creating a table needs NEXT_PUBLIC_ETH_BLACKJACK_ADDRESS."}
      </p>
      {qr ? (
        <div className="qr-panel">
          <img src={qr} alt="WalletConnect code" />
          <p className="hint">Scan with MetaMask or another Ethereum wallet, then approve the connection. Connecting does not send a transaction.</p>
          <button className="texty" type="button" onClick={cancelCode}>Cancel</button>
        </div>
      ) : null}
      {error ? <p className="banner bad" role="alert">{error}</p> : null}
      {notice ? <p className="banner good">{notice}</p> : null}
      {badTable ? <p className="banner bad" role="alert">That table link is not an Ethereum table id.</p> : null}
      {!BLACKJACK_ADDRESS && tableRaw && !badTable ? (
        <p className="banner bad" role="alert">The Ethereum contract is not deployed yet, so this table cannot be loaded.</p>
      ) : null}

      {tableId && game ? (
        <TableView
          table={tableRaw ?? tableId.toString()}
          game={game}
          seat={seat}
          busy={busy}
          secondsLeft={secondsLeft}
          timedOut={timedOut}
          playerClaims={playerClaims}
          dealerClaims={dealerClaims}
          connected={wallet !== null}
          secretGap={hasSecrets === false && game.status !== 0 && game.status !== 8}
          canJoin={game.invite === zeroAddress || (account !== null && same(account, game.invite))}
          onCopy={() => void copyLink(tableId.toString(), setNotice, setError)}
          onHit={() => run(() => send("hit", [tableId]))}
          onStand={() => run(() => send("stand", [tableId]))}
          onCancel={() => run(async () => {
            await send("cancelGame", [tableId]);
            router.push("/?chain=sepolia");
          })}
          onJoin={() => run(joinTable)}
          onClaim={() => run(() => send("claimTimeout", [tableId]))}
          onDealerOpening={() => run(async () => {
            const seeds = await withSeeds("dealer");
            await send("dealerRevealOpening", [tableId, openingSeeds(seeds)]);
          })}
          onPlayerOpening={() => run(async () => {
            const seeds = await withSeeds("player");
            await send("playerRevealOpening", [tableId, openingSeeds(seeds)]);
          })}
          onDealerHit={() => run(async () => {
            const seeds = await withSeeds("dealer");
            await send("dealerRevealHit", [tableId, hitSeed(seeds, game.nextPlayerHit)]);
          })}
          onPlayerHit={() => run(async () => {
            const seeds = await withSeeds("player");
            await send("playerRevealHit", [tableId, hitSeed(seeds, game.nextPlayerHit)]);
          })}
          onDealerShowdown={() => run(async () => {
            const seeds = await withSeeds("dealer");
            const showdown = showdownSeeds(seeds);
            await send("dealerRevealShowdown", [tableId, showdown.hole, showdown.hits]);
          })}
          onPlayerShowdown={() => run(async () => {
            const seeds = await withSeeds("player");
            const showdown = showdownSeeds(seeds);
            await send("playerRevealShowdown", [tableId, showdown.hole, showdown.hits]);
          })}
        />
      ) : tableId && BLACKJACK_ADDRESS && !loaded ? (
        <p className="boot">Looking up the table…</p>
      ) : (
        <Lobby
          table={tableRaw}
          missing={loaded && game === null}
          undeployed={!BLACKJACK_ADDRESS}
          stake={stake}
          invite={invite}
          busy={busy}
          connected={wallet !== null}
          onStake={setStake}
          onInvite={setInvite}
          onCreate={() => void run(createTable)}
          onOpen={(value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            const fromLink = trimmed.includes("table=")
              ? new URL(trimmed, window.location.origin).searchParams.get("table")
              : trimmed;
            if (!fromLink || !/^[1-9]\d*$/.test(fromLink)) {
              setError("Paste a Sepolia table id or invite link.");
              return;
            }
            router.push(`/?chain=sepolia&table=${fromLink}`);
          }}
        />
      )}
    </main>
  );
}

async function copyLink(table: string, setNotice: (value: string) => void, setError: (value: string | null) => void) {
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/?chain=sepolia&table=${table}`);
    setNotice("Invite link copied.");
    setError(null);
  } catch {
    setError("Could not copy the link.");
  }
}

function Lobby({
  table,
  missing,
  undeployed,
  stake,
  invite,
  busy,
  connected,
  onStake,
  onInvite,
  onCreate,
  onOpen,
}: {
  table: string | null;
  missing: boolean;
  undeployed: boolean;
  stake: string;
  invite: string;
  busy: boolean;
  connected: boolean;
  onStake: (value: string) => void;
  onInvite: (value: string) => void;
  onCreate: () => void;
  onOpen: (value: string) => void;
}) {
  const [link, setLink] = useState("");
  return (
    <section className="lobby">
      <div className="intro">
        <p className="eyebrow">Heads-up blackjack</p>
        <h1>Both players fund the pot. The winner takes it.</h1>
        <p>
          You play the hand. The other wallet is the dealer and stands on 17.
          Cards come from secrets you both commit before either one is shown, so
          neither side can pick the deck. A tie sends both buy-ins back.
        </p>
      </div>
      <div className="panels">
        <form className="panel" onSubmit={(event) => { event.preventDefault(); onCreate(); }}>
          <h2>Open a table</h2>
          <label>
            Buy-in (ETH)
            <input value={stake} onChange={(event) => onStake(event.target.value)} inputMode="decimal" min="0.01" max="50" step="0.01" />
          </label>
          <label>
            Reserve for a wallet
            <input value={invite} onChange={(event) => onInvite(event.target.value)} placeholder="Optional. Leave empty for anyone." spellCheck={false} />
          </label>
          <button className="solid" type="submit" disabled={busy || !connected || undeployed}>
            {undeployed ? "Contract is not deployed" : connected ? "Fund pot and create" : "Connect a wallet to create"}
          </button>
          <p className="hint">Cancel before anyone sits to get the buy-in back. Test ETH comes from a Sepolia faucet.</p>
        </form>
        <form className="panel" onSubmit={(event) => { event.preventDefault(); onOpen(link); }}>
          <h2>Sit at a table</h2>
          <label>
            Invite link or table id
            <input value={link} onChange={(event) => setLink(event.target.value)} placeholder="Paste a link" spellCheck={false} />
          </label>
          <button className="solid alt" type="submit" disabled={busy || link.trim().length === 0}>Open table</button>
          {table && missing ? <p className="hint">No table is using that id on Sepolia yet.</p> : null}
        </form>
      </div>
      <details className="rules">
        <summary>How the hand is settled</summary>
        <ul>
          <li>Each seat deposits the same amount. The contract holds it and pays the winner.</li>
          <li>Aces are 1 or 11. Face cards are 10. The dealer stands on every 17, including a soft 17.</li>
          <li>A two-card 21 is a normal win. The pot is even, so there is no 3:2 payout.</li>
          <li>If you bust, the dealer takes the pot without playing the hole card.</li>
          <li>Each step has 10 minutes. If the other seat stops signing, you can claim the pot.</li>
          <li>Card secrets stay in this browser. Clearing site data during a hand means you cannot reveal.</li>
        </ul>
      </details>
    </section>
  );
}

function TableView(props: {
  table: string;
  game: EthTable;
  seat: Seat;
  busy: boolean;
  secondsLeft: number | null;
  timedOut: boolean;
  playerClaims: boolean;
  dealerClaims: boolean;
  connected: boolean;
  canJoin: boolean;
  secretGap: boolean;
  onCopy: () => void;
  onHit: () => void;
  onStand: () => void;
  onCancel: () => void;
  onJoin: () => void;
  onClaim: () => void;
  onDealerOpening: () => void;
  onPlayerOpening: () => void;
  onDealerHit: () => void;
  onPlayerHit: () => void;
  onDealerShowdown: () => void;
  onPlayerShowdown: () => void;
}) {
  const { game, seat } = props;
  const settled = game.status === 8;
  const showHole = !settled && game.dealerCards.length === 1;
  const dealerTotal = game.dealerCards.length === 0
    ? "—"
    : showHole
      ? `showing ${handTotal(game.dealerCards)}`
      : String(handTotal(game.dealerCards));
  const playerTotal = game.playerCards.length === 0 ? "—" : String(handTotal(game.playerCards));
  return (
    <section className="table-layout">
      <div className="felt">
        <Hand title={game.dealer === zeroAddress ? "Dealer" : `Dealer · ${shortAddress(game.dealer)}`} cards={game.dealerCards} hole={showHole || game.dealerCards.length === 0} total={dealerTotal} emptyCount={game.dealerCards.length === 0 ? 2 : 0} />
        <div className="pot">
          <span>Pot</span>
          <strong>{formatEth(game.pot)} ETH</strong>
          <small>{props.secondsLeft === null ? "No clock yet" : props.timedOut ? "Timed out" : `${formatClock(props.secondsLeft)} left`}</small>
        </div>
        <Hand title={`Player · ${shortAddress(game.player)}`} cards={game.playerCards} total={playerTotal} emptyCount={game.playerCards.length === 0 ? 2 : 0} />
        <div className="actions">
          <p className="status">{STATUS[game.status] ?? "Unknown state"}{settled ? ` · ${resultText(game)}` : ""}</p>
          {props.secretGap ? <p className="hint warn">Card secrets for your seat are not in this browser.</p> : null}
          <div className="buttons">
            <Actions {...props} />
          </div>
        </div>
      </div>
      <aside className="side">
        <h2>Table</h2>
        <dl>
          <div><dt>Player</dt><dd>{shortAddress(game.player)}</dd></div>
          <div><dt>Dealer</dt><dd>{game.dealer === zeroAddress ? "Open seat" : shortAddress(game.dealer)}</dd></div>
          <div><dt>Buy-in</dt><dd>{formatEth(game.stake)} ETH each</dd></div>
          <div><dt>You</dt><dd>{seat === "spectator" ? "Watching" : seat === "player" ? "Player" : "Dealer"}</dd></div>
        </dl>
        <button className="solid alt" type="button" onClick={props.onCopy}>Copy invite link</button>
        <p className="hint">The dealer does not choose cards. They sign to reveal the secrets they committed when they sat down. The contract then stands them on 17.</p>
      </aside>
    </section>
  );
}

function Hand({ title, cards, total, hole = false, emptyCount = 0 }: { title: string; cards: number[]; total: string; hole?: boolean; emptyCount?: number }) {
  return (
    <section className="hand">
      <header>
        <h2>{title}</h2>
        <span>{total}</span>
      </header>
      <div className="cards">
        {cards.map((card, index) => <PlayingCard key={`${card}-${index}`} card={card} />)}
        {hole && cards.length > 0 ? <PlayingCard faceDown /> : null}
        {Array.from({ length: emptyCount }, (_, index) => <PlayingCard key={`empty-${index}`} faceDown />)}
      </div>
    </section>
  );
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function Actions(props: {
  game: EthTable;
  seat: Seat;
  busy: boolean;
  connected: boolean;
  canJoin: boolean;
  playerClaims: boolean;
  dealerClaims: boolean;
  onHit: () => void;
  onStand: () => void;
  onCancel: () => void;
  onJoin: () => void;
  onClaim: () => void;
  onDealerOpening: () => void;
  onPlayerOpening: () => void;
  onDealerHit: () => void;
  onPlayerHit: () => void;
  onDealerShowdown: () => void;
  onPlayerShowdown: () => void;
}) {
  const { game, seat, busy, connected } = props;
  if (!connected) return <p className="hint">Connect a wallet to take a seat or act.</p>;
  if (game.status === 0 && seat === "player") {
    return <button className="solid alt" type="button" disabled={busy} onClick={props.onCancel}>Cancel and refund</button>;
  }
  if (game.status === 0 && seat === "spectator") {
    if (!props.canJoin) return <p className="hint">This table is reserved for another wallet.</p>;
    return <button className="solid" type="button" disabled={busy} onClick={props.onJoin}>Match the buy-in and deal</button>;
  }
  if (seat === "dealer" && game.status === 1) {
    return <button className="solid" type="button" disabled={busy} onClick={props.onDealerOpening}>Reveal opening cards</button>;
  }
  if (seat === "player" && game.status === 2) {
    return <button className="solid" type="button" disabled={busy} onClick={props.onPlayerOpening}>Turn the cards</button>;
  }
  if (seat === "player" && game.status === 3) {
    return (
      <>
        <button className="solid" type="button" disabled={busy || game.nextPlayerHit >= 6} onClick={props.onHit}>Hit</button>
        <button className="solid alt" type="button" disabled={busy} onClick={props.onStand}>Stand</button>
      </>
    );
  }
  if (seat === "dealer" && game.status === 4) {
    return <button className="solid" type="button" disabled={busy} onClick={props.onDealerHit}>Reveal the hit card</button>;
  }
  if (seat === "player" && game.status === 5) {
    return <button className="solid" type="button" disabled={busy} onClick={props.onPlayerHit}>Take the card</button>;
  }
  if (seat === "dealer" && game.status === 6) {
    return <button className="solid" type="button" disabled={busy} onClick={props.onDealerShowdown}>Reveal the hole card</button>;
  }
  if (seat === "player" && game.status === 7) {
    return <button className="solid" type="button" disabled={busy} onClick={props.onPlayerShowdown}>Show the dealer hand</button>;
  }
  if ((seat === "player" && props.playerClaims) || (seat === "dealer" && props.dealerClaims)) {
    return <button className="solid" type="button" disabled={busy} onClick={props.onClaim}>Claim the pot</button>;
  }
  if (game.status === 8) return <a className="solid alt linkish" href="/?chain=sepolia">New table</a>;
  return <p className="hint">Waiting for the other seat to sign.</p>;
}
