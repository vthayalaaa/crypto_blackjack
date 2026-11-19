// Run by payout.test.ts in several processes at once, with the working directory
// set to a scratch folder. Each process adds its own sessions to the shared store.
import { update } from "../server/store.ts";

const [name, count] = [process.argv[2] ?? "p", Number(process.argv[3] ?? "10")];
for (let index = 0; index < count; index += 1) {
  await update((db) => {
    db.sessions[`${name}-${index}`] = { tableId: "shared", seat: 0 };
  });
}
