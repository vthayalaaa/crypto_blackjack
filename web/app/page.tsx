import { Suspense } from "react";
import { Casino } from "../components/Casino";

export default function Page() {
  return (
    <Suspense fallback={<main className="boot">Opening the table…</main>}>
      <Casino />
    </Suspense>
  );
}
