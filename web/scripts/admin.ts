import { execFile } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { loadActivity, renderActivity } from "../lib/server/activity.ts";
import { loadTables } from "../lib/server/admin.ts";
import { consoleBanner, consoleRule } from "../lib/server/banner.ts";
import { loadEnvFile } from "../lib/server/envfile.ts";
import { parseCluster } from "../lib/server/money.ts";
import { pidsOnPort, restartServer } from "../lib/server/restart.ts";
import { formatSweepResult, sweepEnvName, sweepFees } from "../lib/server/sweep.ts";
import { networkLabel, type Cluster } from "../lib/table-view.ts";

loadEnvFile(path.join(process.cwd(), ".env.local"));

const port = portOf(process.env.PORT);
const root = process.cwd();
const args = process.argv.slice(2);
const command = args[0] ?? "";

if (command === "tables") {
  const which = args[1] === "completed" ? "completed" : args[1] === "active" ? "active" : "";
  if (!which) fail("Usage: npm run admin -- tables <active|completed>");
  await showTables(which);
} else if (command === "sweep") {
  const clusterArg = args.find((arg) => !arg.startsWith("--") && arg !== "sweep");
  if (!clusterArg) fail("Usage: npm run admin -- sweep <devnet|mainnet|localnet|sepolia|ethereum> [--send]");
  if (await showSweep(parseCluster(clusterArg), args.includes("--send"))) process.exitCode = 1;
} else if (command === "logs" || command === "activity") {
  await showActivity(logLimit(args[1]));
} else if (command === "restart") {
  if (!args.includes("--yes")) fail("Usage: npm run admin -- restart --yes");
  await showRestart();
} else if (command) {
  fail("Usage: npm run admin -- [tables <active|completed> | logs [lines] | sweep <cluster> [--send] | restart --yes]");
} else {
  await menu();
}

type Prompt = { ask(prompt: string): Promise<string | null>; close(): void };

async function menu(): Promise<void> {
  // Read the port before taking input. A piped script would otherwise end
  // while that check is still running.
  let status = await serverLine();
  const prompt = await openPrompt();
  console.log(`\n${consoleBanner()}`);
  try {
    for (;;) {
      console.log(consoleRule());
      console.log(`\n${status}\n`);
      console.log("  1  View tables");
      console.log("  2  View logs");
      console.log("  3  Sweep fees");
      console.log("  4  Restart server");
      console.log("  5  Quit");
      const choice = await prompt.ask("\n> ");
      if (choice === null || choice === "5" || choice === "q" || choice === "quit") return;
      if (choice === "1") await tablesMenu(prompt);
      else if (choice === "2") await logsMenu(prompt);
      else if (choice === "3") await sweepMenu(prompt);
      else if (choice === "4") await restartMenu(prompt);
      else console.log("Choose 1, 2, 3, 4, or 5.");
      status = await serverLine();
    }
  } finally {
    prompt.close();
  }
}

async function tablesMenu(prompt: Prompt): Promise<void> {
  for (;;) {
    console.log(`\n${consoleRule()}\nTables\n`);
    console.log("  1  Active");
    console.log("  2  Completed");
    console.log("  3  Back");
    const choice = await prompt.ask("\n> ");
    if (choice === null || choice === "3" || choice === "b" || choice === "back") return;
    if (choice === "1") await showTables("active");
    else if (choice === "2") await showTables("completed");
    else console.log("Choose 1, 2, or 3.");
  }
}

async function logsMenu(prompt: Prompt): Promise<void> {
  for (;;) {
    console.log(`\n${consoleRule()}\nLogs\n`);
    console.log("  1  Last 50");
    console.log("  2  Last 200");
    console.log("  3  Back");
    const choice = await prompt.ask("\n> ");
    if (choice === null || choice === "3" || choice === "b" || choice === "back") return;
    if (choice === "1") await showActivity(50);
    else if (choice === "2") await showActivity(200);
    else console.log("Choose 1, 2, or 3.");
  }
}

async function sweepMenu(prompt: Prompt): Promise<void> {
  const clusters: Cluster[] = ["devnet", "mainnet", "localnet", "sepolia", "ethereum"];
  for (;;) {
    console.log(`\n${consoleRule()}\nSweep fees\n`);
    clusters.forEach((cluster, index) => console.log(`  ${index + 1}  ${networkLabel(cluster)}`));
    console.log("  6  Back");
    const choice = await prompt.ask("\n> ");
    if (choice === null || choice === "6" || choice === "b" || choice === "back") return;
    const cluster = clusters[Number(choice) - 1];
    if (!cluster) {
      console.log("Choose 1 to 6.");
      continue;
    }
    console.log(`\n${networkLabel(cluster)}\n`);
    console.log("  1  Dry run");
    console.log("  2  Send to the master wallet");
    console.log("  3  Back");
    const action = await prompt.ask("\n> ");
    if (action === null || action === "3" || action === "b" || action === "back") continue;
    if (action === "1") await showSweep(cluster, false);
    else if (action === "2") {
      const word = await prompt.ask(`\nType send to move ${networkLabel(cluster)} fee reserves: `);
      if (word === "send") await showSweep(cluster, true);
      else console.log("Sweep not sent.");
    } else console.log("Choose 1, 2, or 3.");
  }
}

async function restartMenu(prompt: Prompt): Promise<void> {
  const running = await listening();
  const verb = running ? "restart" : "start";
  console.log(running
    ? `\nThis stops the server on port ${port} and starts it again. Hands stay on disk.`
    : `\nThe server is not running. Start it on port ${port}?`);
  const word = await prompt.ask(`Type ${verb} to continue: `);
  if (word !== verb) {
    console.log("Server left as it is.");
    return;
  }
  await showRestart();
}

async function showActivity(limit: number): Promise<void> {
  console.log(`\nLogs\n`);
  console.log("data/activity.jsonl\n");
  try {
    console.log(renderActivity(await loadActivity(limit)));
  } catch (error) {
    console.log(error instanceof Error ? error.message : "The activity log could not be read.");
  }
}

async function showTables(which: "active" | "completed"): Promise<void> {
  const loaded = await loadTables(which);
  console.log(`\n${which === "active" ? "Active" : "Completed"} tables\n`);
  console.log(loaded.text);
  if (loaded.broken > 0) console.log(`\n${loaded.broken} archive lines could not be read.`);
}

async function showSweep(cluster: Cluster, send: boolean): Promise<boolean> {
  const destination = process.env[sweepEnvName(cluster)] ?? "";
  const result = await sweepFees(cluster, destination, send);
  console.log(`\n${formatSweepResult(cluster, result, send, destination)}`);
  return result.errors.length > 0;
}

async function showRestart(): Promise<void> {
  const result = await restartServer(port, root);
  console.log(result === "restarted" ? `Server restarted at http://127.0.0.1:${port}` : `Server started at http://127.0.0.1:${port}`);
}

async function serverLine(): Promise<string> {
  try {
    return await listening() ? `Server is running on port ${port}.` : `Server is not running.`;
  } catch {
    return "Server status is unknown.";
  }
}

async function listening(): Promise<boolean> {
  const text = await runNetstat();
  return pidsOnPort(text, port).length > 0;
}

function runNetstat(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function openPrompt(): Promise<Prompt> {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return { ask: (prompt) => ask(rl, prompt), close: () => rl.close() };
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let index = 0;
  return {
    ask(prompt: string) {
      process.stdout.write(prompt);
      if (index >= lines.length) return Promise.resolve(null);
      const line = lines[index++]!;
      process.stdout.write(`${line}\n`);
      return Promise.resolve(line);
    },
    close() {},
  };
}

function ask(rl: readline.Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rl.once("close", () => finish(null));
    try {
      rl.question(prompt, (answer) => finish(answer.trim()));
    } catch {
      finish(null);
    }
  });
}

function portOf(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000;
}

function logLimit(raw: string | undefined): number {
  const text = raw ?? "50";
  if (!/^\d+$/.test(text)) fail("Usage: npm run admin -- logs [lines]");
  const limit = Number(text);
  if (limit < 1 || limit > 1000) fail("Usage: npm run admin -- logs [lines]");
  return limit;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
