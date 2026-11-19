import path from "node:path";
import { loadEnvFile } from "../lib/server/envfile.ts";
import { parseCluster } from "../lib/server/money.ts";
import { formatSweepResult, sweepEnvName, sweepFees } from "../lib/server/sweep.ts";

loadEnvFile(path.join(process.cwd(), ".env.local"));

const args = process.argv.slice(2);
const send = args.includes("--send");
const clusterArg = args.find((arg) => !arg.startsWith("--"));
if (!clusterArg) {
  console.error("Usage: npm run sweep -- <devnet|mainnet|localnet|sepolia|ethereum> [--send]");
  process.exit(1);
}

const cluster = parseCluster(clusterArg);
const destination = process.env[sweepEnvName(cluster)] ?? "";
const result = await sweepFees(cluster, destination, send);
console.log(formatSweepResult(cluster, result, send, destination));
if (result.errors.length > 0) process.exit(1);
