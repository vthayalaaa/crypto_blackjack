import {
  WalletAdapterNetwork,
  WalletConnectionError,
  WalletNotConnectedError,
  WalletSignTransactionError,
  WalletWindowClosedError,
} from "@solana/wallet-adapter-base";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createAppKit, type AppKit } from "@reown/appkit/core";
import { solana, solanaDevnet, solanaTestnet } from "@reown/appkit/networks";
import { WalletConnectWalletAdapter } from "@walletconnect/solana-adapter";
import type { SessionTypes } from "@walletconnect/types";
import { UniversalProvider } from "@walletconnect/universal-provider";
import { getChainFromAccount, parseAccountId } from "@walletconnect/utils";
import base58 from "bs58";
import { Buffer } from "buffer";

// Phone wallets implement WalletConnect for Solana mainnet only. A devnet-only
// proposal is scanned and then ignored. The app RPC stays on devnet.
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAINNET_LEGACY = "solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ";
const METHODS = ["solana_signTransaction", "solana_signMessage"];

const APP_NAME = "Sol Blackjack";
const APP_DESCRIPTION = "Two-player blackjack escrow on Solana devnet";

let singleton: FixedWalletConnectAdapter | null = null;

export function getWalletConnectAdapter(projectId: string) {
  singleton ??= new FixedWalletConnectAdapter(projectId);
  return singleton;
}

function appMetadata() {
  const origin = window.location.origin;
  const host = window.location.hostname;
  const remote =
    window.location.protocol === "https:" &&
    host !== "localhost" &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(host);
  return {
    name: APP_NAME,
    description: APP_DESCRIPTION,
    url: origin,
    icons: remote ? [`${origin}/icon.svg`] : [],
  };
}

export class FixedWalletConnectAdapter extends WalletConnectWalletAdapter {
  private provider: InstanceType<typeof UniversalProvider> | null = null;
  private session: SessionTypes.Struct | null = null;
  private key: PublicKey | null = null;
  private chainId = MAINNET;
  private busy = false;
  private attempt = 0;
  private modal: AppKit | null = null;
  private readonly projectId: string;

  constructor(projectId: string) {
    super({
      network: WalletAdapterNetwork.Devnet,
      options: {
        projectId,
        metadata: appMetadata(),
      },
    });
    this.projectId = projectId;
  }

  override get publicKey() {
    return this.key;
  }

  override get connecting() {
    return this.busy;
  }

  override async connect() {
    if (this.connected || this.busy) return;
    const attempt = ++this.attempt;
    this.busy = true;
    try {
      const provider = await this.ensureProvider();
      if (provider.session) {
        this.adopt(provider.session);
        return;
      }
      const modal = await this.ensureModal(provider);
      await modal.open();

      let settled = false;
      let unsubscribe = () => {};
      let closeTimer = 0;
      const sessionPromise = provider.connect({
        optionalNamespaces: {
          solana: {
            chains: [MAINNET, MAINNET_LEGACY],
            methods: METHODS,
            events: [],
          },
        },
      });
      // The modal can close when the phone pairs, before the user approves.
      // Keep the proposal alive and adopt the session whenever it arrives.
      sessionPromise.then((session: SessionTypes.Struct | undefined) => {
        if (attempt !== this.attempt || !session || this.key) return;
        try {
          this.adopt(session);
        } catch (error) {
          this.emit("error", new WalletConnectionError(
            error instanceof Error ? error.message : "WalletConnect could not connect.",
            error,
          ));
        }
      }).catch(() => {});

      const cancelled = new Promise<never>((_, reject) => {
        unsubscribe = modal.subscribeState((state) => {
          if (state.open) return;
          window.clearTimeout(closeTimer);
          closeTimer = window.setTimeout(() => {
            if (settled || provider.session || this.key) return;
            reject(new WalletWindowClosedError());
          }, 500);
        });
      });

      try {
        const session = await Promise.race([sessionPromise, cancelled]);
        settled = true;
        if (!session) throw new Error("WalletConnect did not return a session.");
        this.adopt(session);
      } catch (error) {
        settled = true;
        if (provider.session) {
          this.adopt(provider.session);
          return;
        }
        throw error;
      } finally {
        settled = true;
        window.clearTimeout(closeTimer);
        unsubscribe();
        await modal.close();
      }
    } finally {
      if (attempt === this.attempt) this.busy = false;
    }
  }

  override async disconnect() {
    this.attempt += 1;
    const provider = this.provider;
    this.key = null;
    this.session = null;
    try {
      if (provider?.session) await provider.disconnect();
    } catch (error) {
      console.error("WalletConnect disconnect failed", error);
    }
    this.emit("disconnect");
  }

  override async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    const provider = this.provider;
    const session = this.session;
    if (!provider || !session || !this.key) throw new WalletNotConnectedError();
    try {
      const versioned = transaction instanceof VersionedTransaction;
      const bytes = versioned
        ? transaction.serialize()
        : transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const result = await provider.client.request<{ signature?: string; transaction?: string }>({
        chainId: this.chainId,
        topic: session.topic,
        request: {
          method: "solana_signTransaction",
          params: {
            transaction: Buffer.from(bytes).toString("base64"),
          },
        },
      });
      if (result.transaction) {
        const signed = Buffer.from(result.transaction, "base64");
        return (versioned ? VersionedTransaction.deserialize(signed) : Transaction.from(signed)) as T;
      }
      if (!result.signature || versioned) {
        throw new Error("The wallet returned an empty signature.");
      }
      transaction.addSignature(this.key, Buffer.from(base58.decode(result.signature)));
      return transaction;
    } catch (error) {
      const wrapped = error instanceof WalletNotConnectedError || error instanceof WalletSignTransactionError
        ? error
        : new WalletSignTransactionError(error instanceof Error ? error.message : "The wallet could not sign.", error);
      this.emit("error", wrapped);
      throw wrapped;
    }
  }

  private adopt(session: SessionTypes.Struct) {
    const accounts = session.namespaces.solana?.accounts ?? [];
    const account = accounts.find((item) => item.startsWith(`${MAINNET}:`))
      ?? accounts.find((item) => item.startsWith("solana:"))
      ?? accounts[0];
    if (!account) throw new Error("The wallet did not share a Solana account.");
    this.chainId = getChainFromAccount(account);
    this.provider?.setDefaultChain(this.chainId);
    this.session = session;
    this.key = new PublicKey(parseAccountId(account).address);
    this.emit("connect", this.key);
  }

  private async ensureProvider(): Promise<InstanceType<typeof UniversalProvider>> {
    if (this.provider) return this.provider;
    const provider = await UniversalProvider.init({
      projectId: this.projectId,
      metadata: appMetadata(),
    });
    provider.on("session_delete", () => {
      this.attempt += 1;
      this.key = null;
      this.session = null;
      this.emit("disconnect");
    });
    this.provider = provider;
    return provider;
  }

  private async ensureModal(provider: InstanceType<typeof UniversalProvider>) {
    if (this.modal) return this.modal;
    // Installed viem copies disagree on AppKit's network type. The values are the Solana networks AppKit expects.
    this.modal = createAppKit({
      projectId: this.projectId,
      universalProvider: provider,
      networks: [solana, solanaDevnet, solanaTestnet],
      manualWCControl: true,
    } as unknown as Parameters<typeof createAppKit>[0]);
    return this.modal;
  }
}
