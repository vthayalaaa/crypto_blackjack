"use client";

import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { createContext, useContext, useEffect, useState } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";

export type ClusterName = "devnet" | "localnet" | "mainnet" | "sepolia" | "ethereum";

export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

const SOLANA_MAINNET_RPC = "https://solana-rpc.publicnode.com";
const configuredDevnet = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const SOLANA_ENDPOINTS = {
  devnet: configuredDevnet.includes("mainnet") || configuredDevnet === SOLANA_MAINNET_RPC
    ? "https://api.devnet.solana.com"
    : configuredDevnet,
  localnet: "http://127.0.0.1:8899",
  mainnet: SOLANA_MAINNET_RPC,
} as const;

const ClusterContext = createContext<{
  cluster: ClusterName;
  setCluster: (cluster: ClusterName) => void;
  endpoint: string;
} | null>(null);

export function useCluster() {
  const value = useContext(ClusterContext);
  if (!value) throw new Error("Cluster provider is missing.");
  return value;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [cluster, setCluster] = useState<ClusterName>("devnet");
  // Ethereum pages still mount the Solana providers. Keep that RPC off mainnet.
  const endpoint = cluster === "mainnet"
    ? SOLANA_ENDPOINTS.mainnet
    : cluster === "localnet"
      ? SOLANA_ENDPOINTS.localnet
      : SOLANA_ENDPOINTS.devnet;
  const [wallets, setWallets] = useState<Adapter[]>([]);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    const chain = new URLSearchParams(window.location.search).get("chain");
    if (
      (cluster !== "devnet" && cluster !== "mainnet")
      || WALLETCONNECT_PROJECT_ID.length === 0
      || chain === "sepolia"
      || chain === "ethereum"
    ) {
      setWallets([]);
      return;
    }
    let cancelled = false;
    let removeConnect: (() => void) | undefined;
    const onConnect = () => setWalletError(null);
    void import("../lib/walletconnect-adapter").then(({ getWalletConnectAdapter }) => {
      if (cancelled) return;
      const adapter = getWalletConnectAdapter(WALLETCONNECT_PROJECT_ID);
      adapter.on("connect", onConnect);
      removeConnect = () => adapter.off("connect", onConnect);
      setWallets([adapter]);
    });
    return () => {
      cancelled = true;
      removeConnect?.();
    };
  }, [cluster]);

  function onWalletError(error: WalletError) {
    if (error.name === "WalletWindowClosedError") return;
    setWalletError(error.message || "The wallet could not connect.");
  }

  return (
    <ClusterContext.Provider value={{ cluster, setCluster, endpoint }}>
      <ConnectionProvider endpoint={endpoint} key={endpoint}>
        <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
          <WalletModalProvider>
            {walletError ? <p className="banner bad" role="alert">{walletError}</p> : null}
            {children}
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ClusterContext.Provider>
  );
}
