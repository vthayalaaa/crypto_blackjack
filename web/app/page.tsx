import { Suspense } from "react";
import { Casino } from "../components/Casino";

export default function Page() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  return (
    <Suspense fallback={<main className="boot">Opening the table…</main>}>
      <Casino
        supabaseUrl={process.env.SUPABASE_URL ?? ""}
        supabaseKey={key.startsWith("sb_secret_") ? "" : key}
      />
    </Suspense>
  );
}
