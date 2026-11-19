"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { chainFromUrl } from "../lib/table-view";
import { HouseTable } from "./HouseTable";
import { useCluster } from "./Providers";

export function Casino({
  supabaseUrl = "",
  supabaseKey = "",
}: {
  supabaseUrl?: string;
  supabaseKey?: string;
}) {
  const params = useSearchParams();
  const { cluster, setCluster } = useCluster();
  const fromUrl = chainFromUrl(params.get("chain"));
  useEffect(() => {
    setCluster(fromUrl ?? "mainnet");
  }, [fromUrl, setCluster]);
  return <HouseTable network={fromUrl ?? cluster} supabaseUrl={supabaseUrl} supabaseKey={supabaseKey} />;
}
