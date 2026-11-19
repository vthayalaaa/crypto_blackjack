"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { Cluster } from "../lib/table-view";
import { HouseTable } from "./HouseTable";
import { useCluster } from "./Providers";

function chainFromUrl(value: string | null): Cluster | null {
  if (value === "localnet" || value === "mainnet" || value === "sepolia" || value === "ethereum") return value;
  return null;
}

export function Casino() {
  const params = useSearchParams();
  const { cluster, setCluster } = useCluster();
  const fromUrl = chainFromUrl(params.get("chain"));
  useEffect(() => {
    if (fromUrl) setCluster(fromUrl);
  }, [fromUrl, setCluster]);
  return <HouseTable network={fromUrl ?? cluster} />;
}
