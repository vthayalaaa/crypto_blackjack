import { execFile, spawn } from "node:child_process";
import path from "node:path";

/** PIDs listening on a TCP port, from `netstat -ano -p tcp`. */
export function pidsOnPort(netstat: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstat.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;
    if (!(parts[1] ?? "").endsWith(`:${port}`)) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** The listener is this app's Next server, not some other process that took the port. */
export function isBlackjackServer(command: string, root: string): boolean {
  const text = command.toLowerCase().replaceAll("/", "\\");
  const folder = root.toLowerCase().replaceAll("/", "\\").replace(/\\+$/, "");
  return text.includes("\\next\\") && folder.length > 0 && text.includes(folder);
}

export async function restartServer(port: number, root: string): Promise<"started" | "restarted"> {
  const before = pidsOnPort(await netstat(), port);
  for (const pid of before) {
    const command = await commandOf(pid);
    if (!isBlackjackServer(command, root)) {
      throw new Error(`Port ${port} is used by another program. It was not restarted.`);
    }
  }
  for (const pid of before) await stop(pid);
  if (before.length > 0) await waitForPort(port, false);
  start(port, root);
  if (!await probe(port)) throw new Error("The server was started and did not answer.");
  return before.length > 0 ? "restarted" : "started";
}

function netstat(): Promise<string> {
  return run("netstat", ["-ano", "-p", "tcp"]);
}

function commandOf(pid: number): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve("");
  return run("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
}

function stop(pid: number): Promise<string> {
  return run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => "");
}

function start(port: number, root: string): void {
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
    cwd: root,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function waitForPort(port: number, open: boolean): Promise<void> {
  const until = Date.now() + 15_000;
  for (;;) {
    const listening = pidsOnPort(await netstat(), port).length > 0;
    if (listening === open) return;
    if (Date.now() >= until) throw new Error(open ? "The server did not take the port." : "The old server did not stop.");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function probe(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(60_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
