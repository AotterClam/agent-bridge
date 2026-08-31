import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authSupport,
  createAgentBridge,
  listen,
  parseClaudeAuthStatus,
  reconnectTimeoutMs,
  runLogin,
  type AuthSupport
} from "../src/index.js";

/**
 * The fake adapter is a real child process launched through the production
 * spawn path, so start / status / cancel / timeout exercise the same
 * termination discipline the Codex and Claude logins run under.
 */
async function fakeLogin(directory: string) {
  const script = join(directory, "fake-login.mjs");
  const marker = join(directory, "signed-in");
  const pidFile = join(directory, "login.pid");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_LOGIN_PID_FILE, String(process.pid));
const mode = process.env.FAKE_LOGIN_MODE;
if (mode === "succeed") {
  writeFileSync(process.env.FAKE_LOGIN_MARKER, "ok");
  process.exit(0);
}
if (mode === "exit-zero-without-signin") process.exit(0);
if (mode === "fail") process.exit(7);
// "hang" refuses SIGTERM so the bounded SIGKILL escalation is what reaps it.
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`
  );
  await chmod(script, 0o755);
  let mode = "hang";
  const support: AuthSupport = {
    label: "fake login",
    async probe() {
      return existsSync(marker)
        ? { state: "ready", detail: "fake marker present" }
        : { state: "auth_required", detail: "fake marker absent" };
    },
    login: () => ({
      command: process.execPath,
      args: [script],
      env: {
        FAKE_LOGIN_MODE: mode,
        FAKE_LOGIN_MARKER: marker,
        FAKE_LOGIN_PID_FILE: pidFile
      }
    })
  };
  return {
    support,
    marker,
    setMode(next: "succeed" | "fail" | "hang" | "exit-zero-without-signin") {
      mode = next;
    },
    async pid() {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (existsSync(pidFile)) return Number(readFileSync(pidFile, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Fake login never reported a pid");
    }
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function harness(options: { timeoutMs?: () => number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-reconnect-"));
  const fake = await fakeLogin(directory);
  const controlToken = "reconnect-test";
  const bridge = createAgentBridge({
    controlToken,
    preloadModels: false,
    logger: { level: "silent" },
    // Only Codex is wired to the fake; Grok keeps the production shape of an
    // adapter with no scriptable login.
    reconnect: { support: { codex: fake.support }, timeoutMs: options.timeoutMs }
  });
  await listen(bridge, 0);
  const address = bridge.server.address();
  const baseUrl = `http://127.0.0.1:${
    typeof address === "object" && address ? address.port : 0
  }`;
  cleanups.push(async () => {
    await bridge.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const call = (path: string, init?: RequestInit) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${controlToken}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers
      }
    });
  return { bridge, fake, call, baseUrl, controlToken };
}

async function settled(
  call: (path: string) => Promise<Response>,
  reconnectId: string
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = (await (await call(`/reconnect/${reconnectId}`)).json()) as {
      state: string;
      detail?: string;
    };
    if (run.state !== "pending") return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Reconnect never settled");
}

test("starts a login, reports it, and flips authState back to ready", async () => {
  const { fake, call, bridge } = await harness();
  fake.setMode("succeed");

  expect(await bridge.reconnectManager.authState("codex")).toEqual({
    authState: "auth_required",
    actions: ["reconnect"]
  });

  const started = await call("/reconnect", {
    method: "POST",
    body: JSON.stringify({ adapter: "codex" })
  });
  expect(started.status).toBe(202);
  const run = (await started.json()) as { reconnectId: string; state: string };
  expect(run).toMatchObject({ adapter: "codex", state: "pending" });

  expect(await settled(call, run.reconnectId)).toMatchObject({
    state: "succeeded",
    detail: "fake marker present"
  });
  expect(existsSync(fake.marker)).toBe(true);
  expect(await bridge.reconnectManager.authState("codex")).toEqual({
    authState: "ready",
    actions: ["reconnect"]
  });
});

test("reports reauth_pending in /capabilities and refuses a second start", async () => {
  const { call, bridge } = await harness();

  const run = (await (
    await call("/reconnect", {
      method: "POST",
      body: JSON.stringify({ adapter: "codex" })
    })
  ).json()) as { reconnectId: string };

  const discovery = (await (await call("/capabilities")).json()) as {
    adapters: Array<{ id: string; authState: string; actions: string[] }>;
  };
  // Every adapter answers the contract, so a host never has to special-case
  // which provider it is looking at.
  expect(
    discovery.adapters.map((adapter) => [adapter.id, adapter.actions]).sort()
  ).toEqual([
    ["antigravity", []],
    ["claude", []],
    ["codex", ["reconnect"]],
    ["grok", []]
  ]);
  expect(discovery.adapters.find((item) => item.id === "codex")?.authState)
    .toBe("reauth_pending");

  const conflict = await call("/reconnect", {
    method: "POST",
    body: JSON.stringify({ adapter: "codex" })
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({
    error: { category: "conflict" }
  });

  const cancelled = await call(`/reconnect/${run.reconnectId}/cancel`, {
    method: "POST"
  });
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({
    state: "failed",
    detail: "Reconnect cancelled."
  });

  // Idempotent: a repeat cancel returns the settled run, not a new flow.
  expect(
    await (
      await call(`/reconnect/${run.reconnectId}/cancel`, { method: "POST" })
    ).json()
  ).toMatchObject({ state: "failed", detail: "Reconnect cancelled." });
  expect((await bridge.reconnectManager.authState("codex")).authState).toBe(
    "auth_required"
  );
}, 15_000);

test("refuses adapters without a scriptable login", async () => {
  const { call, bridge } = await harness();

  expect(await bridge.reconnectManager.authState("grok")).toEqual({
    authState: "ready",
    actions: []
  });
  expect(await bridge.reconnectManager.authState("antigravity")).toEqual({
    authState: "ready",
    actions: []
  });

  const refused = await call("/reconnect", {
    method: "POST",
    body: JSON.stringify({ adapter: "grok" })
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({
    error: {
      category: "unsupported",
      message: "grok does not support reconnect through this bridge."
    }
  });

  // Only codex and claude ship a login in the production support map.
  expect(Object.keys(authSupport).sort()).toEqual(["claude", "codex"]);
});

test("rejects unknown ids, unknown adapters, and the wrong control token", async () => {
  const { call, baseUrl } = await harness();

  expect((await call("/reconnect/reconnect-missing")).status).toBe(404);
  expect(
    (await call("/reconnect/reconnect-missing/cancel", { method: "POST" }))
      .status
  ).toBe(404);

  const invalid = await call("/reconnect", {
    method: "POST",
    body: JSON.stringify({ adapter: "not-an-adapter" })
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    error: { category: "invalid_request" }
  });

  const unauthorized = await fetch(`${baseUrl}/reconnect`, {
    method: "POST",
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({ adapter: "codex" })
  });
  expect(unauthorized.status).toBe(401);
});

test("times out a stalled login and reaps the child", async () => {
  const { fake, call } = await harness({ timeoutMs: () => 200 });

  const run = (await (
    await call("/reconnect", {
      method: "POST",
      body: JSON.stringify({ adapter: "codex" })
    })
  ).json()) as { reconnectId: string };

  const finished = await settled(call, run.reconnectId);
  expect(finished.state).toBe("failed");
  expect(finished.detail).toContain("timed out after 200 ms");

  const pid = await fake.pid();
  // SIGTERM is ignored by the fake, so surviving here would mean the SIGKILL
  // escalation never ran.
  expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);

test("fails a login that exits 0 without signing in", async () => {
  const { fake, call } = await harness();
  fake.setMode("exit-zero-without-signin");

  const run = (await (
    await call("/reconnect", {
      method: "POST",
      body: JSON.stringify({ adapter: "codex" })
    })
  ).json()) as { reconnectId: string };

  expect(await settled(call, run.reconnectId)).toMatchObject({
    state: "failed",
    detail: "fake login exited 0 but the runtime is still signed out."
  });
});

test("surfaces a non-zero login exit and a missing executable", async () => {
  const { fake, call } = await harness();
  fake.setMode("fail");

  const run = (await (
    await call("/reconnect", {
      method: "POST",
      body: JSON.stringify({ adapter: "codex" })
    })
  ).json()) as { reconnectId: string };
  expect(await settled(call, run.reconnectId)).toMatchObject({
    state: "failed",
    detail: "fake login exited 7."
  });

  await expect(
    runLogin(
      {
        label: "absent login",
        probe: async () => ({ state: "ready" }),
        login: () => ({
          command: join(tmpdir(), "agent-bridge-absent-login"),
          args: []
        })
      },
      1_000
    ).done
  ).rejects.toThrow("absent login could not start");
});

test("cancels in-flight logins when the bridge closes", async () => {
  const { fake, call, bridge } = await harness();

  const run = (await (
    await call("/reconnect", {
      method: "POST",
      body: JSON.stringify({ adapter: "codex" })
    })
  ).json()) as { reconnectId: string };
  const pid = await fake.pid();
  expect(() => process.kill(pid, 0)).not.toThrow();

  await bridge.close();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(bridge.reconnectManager.status(run.reconnectId)).toBeUndefined();
}, 15_000);

test("reads the documented claude auth status payload", () => {
  expect(
    parseClaudeAuthStatus(
      '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'
    )
  ).toEqual({
    state: "auth_required",
    detail: "claude auth status loggedIn=false authMethod=none"
  });
  expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claudeai"}'))
    .toMatchObject({ state: "ready" });
  // Anything the bridge cannot read is not evidence of being signed out.
  expect(parseClaudeAuthStatus("not json")).toBeUndefined();
  expect(parseClaudeAuthStatus('{"apiProvider":"firstParty"}')).toBeUndefined();
  expect(parseClaudeAuthStatus(undefined)).toBeUndefined();
});

test("validates the reconnect timeout override", () => {
  expect(reconnectTimeoutMs(undefined)).toBe(300_000);
  expect(reconnectTimeoutMs("60000")).toBe(60_000);
  expect(() => reconnectTimeoutMs("0")).toThrow(
    "AGENT_BRIDGE_RECONNECT_TIMEOUT_MS must be a positive integer"
  );
  expect(() => reconnectTimeoutMs("later")).toThrow(
    "AGENT_BRIDGE_RECONNECT_TIMEOUT_MS must be a positive integer"
  );
});
