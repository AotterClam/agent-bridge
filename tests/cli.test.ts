import { expect, test } from "bun:test";
import { execFile, execSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const exec = promisify(execFile);
const builtCli = join(import.meta.dir, "../dist/cli.js");

// Build before running CLI suite so fresh clone executes the production Node binary
if (!existsSync(builtCli)) {
  execSync("npm run build", { cwd: join(import.meta.dir, ".."), stdio: "ignore" });
}

async function runCli(args: string[], options: Record<string, unknown> = {}) {
  const res = await exec("node", [builtCli, ...args], options as any);
  return {
    stdout: String(res.stdout),
    stderr: String(res.stderr)
  };
}

function spawnCli(args: string[], options: Record<string, unknown> = {}) {
  return spawn("node", [builtCli, ...args], options as any);
}

test("cli reports help with --help or -h", async () => {
  const { stdout } = await runCli(["--help"]);
  expect(stdout.includes("Usage:")).toBe(true);
  expect(stdout.includes("npx @aotterclam/agent-bridge")).toBe(true);
  expect(stdout.includes("--port")).toBe(true);
  expect(stdout.includes("--token")).toBe(true);
  expect(stdout.includes("AGENT_BRIDGE_PORT")).toBe(true);
});

test("cli reports version with --version or -v", async () => {
  const { stdout } = await runCli(["--version"]);
  expect(/@aotterclam\/agent-bridge v\d+\.\d+\.\d+/.test(stdout)).toBe(true);
});

test("cli rejects invalid port values", async () => {
  let error: any = null;
  try {
    await runCli(["--port", "invalid"]);
  } catch (err) {
    error = err;
  }
  expect(error).not.toBeNull();
  const output = String(error.stderr || error.stdout || "");
  expect(output.includes("Invalid port number")).toBe(true);
});

test("cli rejects invalid log format values", async () => {
  let error: any = null;
  try {
    await runCli(["--format", "xml"]);
  } catch (err) {
    error = err;
  }
  expect(error).not.toBeNull();
  const output = String(error.stderr || error.stdout || "");
  expect(output.includes("Invalid format")).toBe(true);
});

test("cli with AGENT_BRIDGE_LOG_FORMAT=json emits pure JSON without ASCII banner", async () => {
  const child = spawnCli(["--port", "0"], {
    env: { ...process.env, AGENT_BRIDGE_LOG_FORMAT: "json", AGENT_BRIDGE_LOG_LEVEL: "info" }
  });

  try {
    const lines: string[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (l) => {
      const trimmed = l.trim();
      if (trimmed) lines.push(trimmed);
    });

    await new Promise((r) => setTimeout(r, 1000));

    // Assert that the child is alive and emitted at least one JSON record
    expect(lines.length).toBeGreaterThan(0);

    for (const l of lines) {
      expect(l.includes("┌")).toBe(false);
      expect(l.includes("│")).toBe(false);
      expect(l.includes("Ready-to-run cURL Examples")).toBe(false);
      const record = JSON.parse(l);
      expect(typeof record).toBe("object");
      expect(record.level).toBeDefined();
    }
  } finally {
    child.kill("SIGTERM");
  }
});

test("cli starts standalone server and responds to discovery", async () => {
  const token = "test-standalone-token";
  const child = spawnCli(["--port", "0", "--token", token], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  try {
    const lines = createInterface({ input: child.stdout });
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CLI startup timed out")), 10_000);
      lines.on("line", (line) => {
        const match = line.match(/http:\/\/127\.0\.0\.1:(\d+)\/v1/);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`CLI exited prematurely with code ${code}`)));
    });

    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });

    const capRes = await fetch(`${baseUrl}/capabilities`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(capRes.status).toBe(200);
    const capData: any = await capRes.json();
    expect(Array.isArray(capData.adapters)).toBe(true);
    expect(capData.adapters.some((a: any) => a.id === "antigravity")).toBe(true);
  } finally {
    child.kill("SIGTERM");
  }
}, 15_000);
