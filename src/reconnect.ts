import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexCommand } from "./codex.js";
import type { AdapterId } from "./index.js";

const exec = promisify(execFile);

const DEFAULT_RECONNECT_TIMEOUT_MS = 300_000;
const AUTH_PROBE_TIMEOUT_MS = 15_000;
/**
 * How long a probe reading stays good without another signal. Sign-in expires
 * on the provider's clock, not on any event this bridge can observe, so a
 * cached `ready` that expires only on an explicit refresh is a reading that
 * can be wrong forever. Short enough that a host polling `/capabilities`
 * notices on its own, long enough that polling does not spawn a CLI per call.
 */
const DEFAULT_PROBE_TTL_MS = 60_000;

/**
 * Provider-neutral sign-in contract.
 *
 * `authState` says whether an adapter can serve a turn right now; `actions`
 * says what a host may do about it. Every adapter reports both, so a host UI
 * renders one control instead of four provider-specific ones. Adapters with no
 * scriptable login report `actions: []` and are refused at `POST /reconnect`
 * rather than starting a flow the bridge cannot finish.
 */
export type AuthState = "ready" | "auth_required" | "reauth_pending";
export type AdapterAction = "reconnect";
export type ReconnectState = "pending" | "succeeded" | "failed";
export type AdapterAuth = {
  authState: AuthState;
  actions: readonly AdapterAction[];
};

/** The settled half of `AuthState` — what a read-only probe can observe. */
export type ProbedAuthState = Exclude<AuthState, "reauth_pending">;
export type AuthProbeResult = { state: ProbedAuthState; detail?: string };

/**
 * How to launch a CLI's own login. Kept as data rather than a closure so tests
 * inject a fake login program through the same code path production uses,
 * including the stdio, environment, and timeout the child really runs with.
 */
export type LoginSpec = {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
};

export type AuthSupport = {
  /** Cheap, read-only check of whether the runtime is signed in. */
  probe: () => Promise<AuthProbeResult>;
  /** Interactive login the adapter owns end to end (browser + its callback). */
  login: () => LoginSpec;
  /** Name of the login command, used in bridge-authored `detail` strings. */
  label: string;
};

export function reconnectTimeoutMs(
  value = process.env.AGENT_BRIDGE_RECONNECT_TIMEOUT_MS
) {
  if (value === undefined) return DEFAULT_RECONNECT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(
      "AGENT_BRIDGE_RECONNECT_TIMEOUT_MS must be a positive integer"
    );
  }
  return timeout;
}

/**
 * The Claude lane runs the Agent SDK, which resolves its own executable, so
 * until now the bridge never needed a `claude` path. Reconnect does: the SDK
 * exposes no sign-in call. Credentials are keyed to the config directory
 * (`CLAUDE_CONFIG_DIR`), not to a particular binary, so signing in through the
 * CLI on that same directory is what the SDK reads back.
 */
export function claudeCommand(): string {
  const override = process.env.AGENT_BRIDGE_CLAUDE_COMMAND;
  if (override) return override;
  const candidates = [
    join(homedir(), ".local/bin", "claude"),
    join("/opt/homebrew/bin", "claude"),
    join("/usr/local/bin", "claude")
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return "claude";
}

/**
 * Codex owns a dedicated login subcommand and a matching status subcommand, so
 * both halves of the contract land on documented CLI surface: `codex login`
 * (browser plus the CLI's own loopback callback) and `codex login status`,
 * whose exit code is the signed-in signal.
 */
export const codexAuthSupport: AuthSupport = {
  label: "codex login",
  async probe() {
    try {
      await exec(codexCommand(), ["login", "status"], {
        timeout: AUTH_PROBE_TIMEOUT_MS
      });
      return { state: "ready", detail: "codex login status exited 0" };
    } catch (error) {
      // A missing executable and a signed-out host both land here. Only the
      // signed-out reading is actionable, but offering a reconnect either way
      // surfaces the real failure instead of a silent 500 on the next turn.
      return {
        state: "auth_required",
        detail: `codex login status failed: ${exitDetail(error)}`
      };
    }
  },
  login() {
    return { command: codexCommand(), args: ["login"] };
  }
};

/**
 * Claude Code exposes `claude auth login|logout|status`.
 * `claude auth status --json` prints `{loggedIn, authMethod, apiProvider}` and
 * exits non-zero when signed out, so detection reads a real field instead of
 * inferring sign-in from a failed turn. The login itself reports nothing
 * machine-readable while it runs; see `runLogin` for why its exit code alone
 * is not trusted.
 */
export const claudeAuthSupport: AuthSupport = {
  label: "claude auth login",
  async probe() {
    let stdout: string;
    try {
      ({ stdout } = await exec(claudeCommand(), ["auth", "status", "--json"], {
        timeout: AUTH_PROBE_TIMEOUT_MS
      }));
    } catch (error) {
      // Signed out is a non-zero exit that still prints the JSON body, so the
      // payload is read before the exit code is believed.
      const parsed = parseClaudeAuthStatus((error as { stdout?: string }).stdout);
      if (parsed) return parsed;
      // Nothing parsable: the probe failed, not the sign-in. Reporting
      // `auth_required` here would put a reconnect prompt in front of a
      // working host whenever the executable moved, so the bridge stays out of
      // the way and lets the next real turn report the truth.
      return {
        state: "ready",
        detail: `claude auth status unavailable: ${exitDetail(error)}`
      };
    }
    return (
      parseClaudeAuthStatus(stdout) ?? {
        state: "ready",
        detail: "claude auth status reported no loggedIn field"
      }
    );
  },
  login() {
    return { command: claudeCommand(), args: ["auth", "login"] };
  }
};

export function parseClaudeAuthStatus(
  stdout: string | undefined
): AuthProbeResult | undefined {
  if (!stdout) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const status =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (typeof status.loggedIn !== "boolean") return undefined;
  return {
    state: status.loggedIn ? "ready" : "auth_required",
    // `authMethod` is an enum the CLI prints beside `loggedIn` (for example
    // "none"). It names a lane, never a credential.
    detail: `claude auth status loggedIn=${status.loggedIn}${
      typeof status.authMethod === "string"
        ? ` authMethod=${status.authMethod}`
        : ""
    }`
  };
}

/**
 * Adapters this bridge can re-authenticate. Anything absent reports
 * `actions: []` and is refused with category `unsupported`: neither Grok Build
 * nor Antigravity exposes a login the bridge can drive without taking over a
 * terminal, and claiming otherwise would strand a host UI on a dead button.
 */
export const authSupport: Partial<Record<AdapterId, AuthSupport>> = {
  codex: codexAuthSupport,
  claude: claudeAuthSupport
};

function exitDetail(error: unknown) {
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    killed?: boolean;
  };
  if (failure?.killed) return "timed out";
  if (typeof failure?.signal === "string") return `killed by ${failure.signal}`;
  if (typeof failure?.code === "number") return `exited ${failure.code}`;
  if (typeof failure?.code === "string") return failure.code;
  return "no exit status";
}

export type ReconnectRun = {
  reconnectId: string;
  adapter: AdapterId;
  state: ReconnectState;
  detail?: string;
};

export class ReconnectUnsupported extends Error {
  readonly status = 400;
  readonly category = "unsupported";
  constructor(adapter: string) {
    super(`${adapter} does not support reconnect through this bridge.`);
  }
}

export class ReconnectConflict extends Error {
  readonly status = 409;
  readonly category = "conflict";
  constructor(adapter: string, readonly reconnectId: string) {
    super(`${adapter} already has a reconnect in progress.`);
  }
}

type ActiveRun = ReconnectRun & { cancel: (reason?: string) => Promise<void> };

/**
 * Owns every in-flight login for one bridge instance.
 *
 * Deliberately narrow: start one CLI login per adapter, report its state,
 * cancel it, and re-probe when it ends. Account listing, quota, and token
 * storage stay with the CLIs that already own them.
 */
export function createReconnectManager(
  options: {
    support?: Partial<Record<AdapterId, AuthSupport>>;
    timeoutMs?: () => number;
    probeTtlMs?: () => number;
    onEvent?: (event: {
      adapter: AdapterId;
      reconnectId: string;
      state: ReconnectState;
    }) => void;
  } = {}
) {
  const support = options.support ?? authSupport;
  const timeout = options.timeoutMs ?? reconnectTimeoutMs;
  const probeTtl = options.probeTtlMs ?? (() => DEFAULT_PROBE_TTL_MS);
  const runs = new Map<string, ActiveRun>();
  const active = new Map<AdapterId, string>();
  /**
   * Cached sign-in readings, invalidated by every signal that can change them:
   *
   * - `GET /capabilities?refresh=1` — the host explicitly asks to re-detect.
   * - A reconnect settling, either way — `settle()` drops the reading, because
   *   a login can leave the runtime signed in or still signed out.
   * - A data-plane turn failing — `recheck()` from the turn lane. This is the
   *   signal that matters in practice: expiry is discovered by the failure it
   *   causes, and a host must not have to parse a runtime error string to
   *   learn that its credential died.
   * - Age — a reading older than `probeTtlMs` is re-probed, so a host that
   *   polls `/capabilities` without running turns still converges.
   *
   * Reconnect *start* needs no entry here: `active` short-circuits the cache
   * to `reauth_pending` for as long as a login runs. Process restart needs no
   * entry either — a new process gets an empty map.
   */
  const probed = new Map<AdapterId, { result: AuthProbeResult; at: number }>();
  // Concurrent failures and concurrent discovery must not each spawn a CLI.
  const inFlight = new Map<AdapterId, Promise<AuthProbeResult>>();

  const probe = (adapter: AdapterId, capability: AuthSupport) => {
    const running = inFlight.get(adapter);
    if (running) return running;
    const started = capability
      .probe()
      .finally(() => inFlight.delete(adapter));
    inFlight.set(adapter, started);
    return started;
  };

  const view = (run: ActiveRun): ReconnectRun => ({
    reconnectId: run.reconnectId,
    adapter: run.adapter,
    state: run.state,
    ...(run.detail ? { detail: run.detail } : {})
  });

  const settle = (run: ActiveRun, state: ReconnectState, detail?: string) => {
    if (run.state !== "pending") return;
    run.state = state;
    run.detail = detail;
    if (active.get(run.adapter) === run.reconnectId) active.delete(run.adapter);
    // A login can change the stored credential either way, so the cached
    // reading is dropped and the next `authState` re-probes the runtime.
    probed.delete(run.adapter);
    options.onEvent?.({
      adapter: run.adapter,
      reconnectId: run.reconnectId,
      state
    });
  };

  return {
    /** Cached sign-in state, with an in-flight login taking precedence. */
    async authState(adapter: AdapterId): Promise<AdapterAuth> {
      const capability = support[adapter];
      const actions: AdapterAction[] = capability ? ["reconnect"] : [];
      if (!capability) return { authState: "ready", actions };
      if (active.has(adapter)) return { authState: "reauth_pending", actions };
      const entry = probed.get(adapter);
      const fresh =
        entry && Date.now() - entry.at < probeTtl() ? entry.result : undefined;
      const result = fresh ?? (await probe(adapter, capability));
      if (!fresh) probed.set(adapter, { result, at: Date.now() });
      // A login that started while the probe was running wins: the probe read
      // the pre-login credential and is already stale.
      if (active.has(adapter)) return { authState: "reauth_pending", actions };
      return { authState: result.state, actions };
    },

    /**
     * Discards the cached reading and re-probes now. The turn lane calls this
     * when an adapter fails, so an expired credential is reported as
     * `auth_required` instead of leaving a host to guess from an error string.
     * Adapters with no probe answer `ready` unchanged — the bridge cannot
     * confirm a sign-in problem it has no way to observe.
     */
    async recheck(adapter: AdapterId): Promise<AdapterAuth> {
      probed.delete(adapter);
      return this.authState(adapter);
    },

    /** Drops cached probe readings so the next `authState` re-runs them. */
    refresh() {
      probed.clear();
    },

    start(adapter: AdapterId): ReconnectRun {
      const capability = support[adapter];
      if (!capability) throw new ReconnectUnsupported(adapter);
      const existing = active.get(adapter);
      if (existing) throw new ReconnectConflict(adapter, existing);

      const login = runLogin(capability, timeout());
      const run: ActiveRun = {
        reconnectId: `reconnect-${crypto.randomUUID()}`,
        adapter,
        state: "pending",
        cancel: login.cancel
      };
      runs.set(run.reconnectId, run);
      active.set(adapter, run.reconnectId);
      void login.done.then(
        (detail) => settle(run, "succeeded", detail),
        (error: Error) => settle(run, "failed", error.message)
      );
      return view(run);
    },

    status(reconnectId: string): ReconnectRun | undefined {
      const run = runs.get(reconnectId);
      return run ? view(run) : undefined;
    },

    /**
     * Idempotent: cancelling a settled run reports what it settled as instead
     * of resurrecting a finished flow.
     */
    async cancel(reconnectId: string): Promise<ReconnectRun | undefined> {
      const run = runs.get(reconnectId);
      if (!run) return undefined;
      await run.cancel();
      settle(run, "failed", "Reconnect cancelled.");
      return view(run);
    },

    async close() {
      await Promise.all(
        [...runs.values()].map((run) => run.cancel("Bridge closed."))
      );
      for (const run of runs.values()) settle(run, "failed", "Bridge closed.");
      runs.clear();
      active.clear();
      probed.clear();
      inFlight.clear();
    }
  };
}

/**
 * Runs one CLI login to completion and returns a handle to it.
 *
 * Subprocess discipline shared with every other runtime this bridge spawns: an
 * `error` listener so a missing executable rejects instead of throwing on the
 * EventEmitter, SIGTERM followed by a bounded SIGKILL, and a timeout that
 * reaches the same terminator as an explicit cancel.
 *
 * All three stdio streams are `ignore`. A login prints an authorization URL
 * carrying state and PKCE parameters, so nothing the child writes is captured,
 * logged, or returned, and `detail` is bridge-authored text only. The cost is
 * stated rather than hidden: the CLI must be able to open a browser and finish
 * on its own loopback callback. Where it falls back to asking the user to
 * paste a code into the terminal, this endpoint cannot complete the flow — it
 * fails on exit or timeout, and the user signs in from a terminal instead.
 */
export function runLogin(capability: AuthSupport, timeoutMs: number) {
  const spec = capability.login();
  const child = spawn(spec.command, [...spec.args], {
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
    stdio: ["ignore", "ignore", "ignore"]
  });

  let stopReason: string | undefined;
  let terminated: Promise<void> | undefined;
  const terminate = () =>
    (terminated ??= (async () => {
      if (child.exitCode != null || child.signalCode != null) return;
      let closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      );
      child.kill("SIGTERM");
      await Promise.race([closed, wait(1_000)]);
      if (child.exitCode != null || child.signalCode != null) return;
      closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      );
      child.kill("SIGKILL");
      await Promise.race([closed, wait(1_000)]);
    })());
  const stop = (reason: string) => {
    stopReason ??= reason;
    return terminate();
  };

  const timer = setTimeout(
    () => void stop(`${capability.label} timed out after ${timeoutMs} ms.`),
    timeoutMs
  );
  timer.unref();

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new Error(`${capability.label} could not start: ${error.message}`)
      )
    );
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const done = (async () => {
    try {
      const { code, signal } = await exited;
      if (stopReason) throw new Error(stopReason);
      if (code !== 0) {
        throw new Error(
          `${capability.label} ${
            signal ? `was killed by ${signal}` : `exited ${code}`
          }.`
        );
      }
      // Exit 0 is necessary but not sufficient: the CLI says nothing else
      // while it runs, so the sign-in is confirmed by re-probing the runtime.
      const probe = await capability.probe();
      if (probe.state !== "ready") {
        throw new Error(
          `${capability.label} exited 0 but the runtime is still signed out.`
        );
      }
      return probe.detail ?? `${capability.label} completed.`;
    } catch (error) {
      throw new Error(
        stopReason ??
          (error instanceof Error ? error.message : `${capability.label} failed.`)
      );
    } finally {
      clearTimeout(timer);
      await terminate();
    }
  })();

  return {
    done,
    cancel: (reason = "Reconnect cancelled.") => stop(reason)
  };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
