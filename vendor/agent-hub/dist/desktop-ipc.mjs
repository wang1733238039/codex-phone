// packages/codex-adapter/src/desktop-ipc.ts
import { connect } from "node:net";
import { lstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname as dirname2, join as join2 } from "node:path";

// packages/codex-adapter/src/windows-process.ts
import { Worker, isMainThread, threadId, workerData } from "node:worker_threads";
var key = Symbol.for("codex-manage.windows-process-gate.v1");
var globals = globalThis;
var unavailable = (timeout = false, spawnStarted = false, cause) => Object.assign(new Error("Windows process creation unavailable", { cause }), {
  code: timeout ? "ETIMEDOUT" : "WINDOWS_PROCESS_GATE_UNAVAILABLE",
  syscall: "windows-process-creation",
  spawnStarted
});
function getWindowsProcessGate() {
  if (isMainThread)
    return (globals[key] ??= {
      shared: new SharedArrayBuffer(4),
      workers: /* @__PURE__ */ new WeakSet(),
      owners: /* @__PURE__ */ new Map()
    }).shared;
  const shared = workerData?.windowsProcessGate;
  if (!(shared instanceof SharedArrayBuffer) || shared.byteLength !== 4) throw unavailable();
  return shared;
}
function registerWindowsProcessWorker(worker) {
  if (!isMainThread || !(worker instanceof Worker) || !Number.isSafeInteger(worker.threadId) || worker.threadId <= 0 || worker.threadId >= 2147483647)
    throw unavailable();
  const shared = getWindowsProcessGate(), registry = globals[key];
  if (registry.workers.has(worker)) return;
  registry.workers.add(worker);
  const id = worker.threadId;
  const token = id + 1;
  registry.owners.set(id, worker);
  worker.once("exit", () => {
    if (registry.owners.get(id) === worker) registry.owners.delete(id);
    const owner = new Int32Array(shared);
    if (Atomics.compareExchange(owner, 0, token, 0) === token) Atomics.notify(owner, 0);
  });
}
function getWindowsProcessWorker(id) {
  if (!isMainThread) throw unavailable();
  const worker = globals[key]?.owners.get(id);
  return worker?.threadId === id ? worker : void 0;
}
function withWindowsProcessCreation(timeoutMs, create, active) {
  if (process.platform !== "win32") {
    if (active && !active()) throw unavailable();
    return create(timeoutMs);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 || threadId >= 2147483647)
    throw unavailable();
  const owner = new Int32Array(getWindowsProcessGate()), token = threadId + 1;
  const deadline = performance.now() + timeoutMs;
  for (; ; ) {
    if (active && !active()) throw unavailable();
    const current = Atomics.load(owner, 0);
    if (current === token) throw unavailable();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw unavailable(true);
    if (current === 0 && Atomics.compareExchange(owner, 0, 0, token) === 0) break;
    Atomics.wait(owner, 0, current, Math.min(50, remaining));
  }
  let invoked = false;
  let value;
  let failure;
  try {
    if (active && !active()) throw unavailable();
    const remaining = Math.min(timeoutMs, Math.floor(deadline - performance.now()));
    if (remaining <= 0) throw unavailable(true);
    invoked = true;
    value = create(remaining);
  } catch (error) {
    failure = { error };
  }
  if (Atomics.compareExchange(owner, 0, token, 0) !== token)
    throw unavailable(false, invoked ? "unknown" : false, failure?.error);
  Atomics.notify(owner, 0);
  if (failure) throw failure.error;
  return value;
}

// packages/codex-adapter/src/runtime.ts
var object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
var list = (value) => Array.isArray(value) ? value : [];
var string = (value) => typeof value === "string" ? value : "";
var CodexRejection = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
};

// packages/codex-adapter/src/desktop-framing.ts
var desktopFrameLimits = {
  materializedBytes: 256 * 1024 * 1024,
  drainedBytes: 512 * 1024 * 1024,
  drainTimeoutMs: 1e4
};
var DesktopFrameDecoder = class {
  constructor(accept, options = {}) {
    this.accept = accept;
    this.options = options;
    this.drainTimeoutMs = options.drainTimeoutMs ?? desktopFrameLimits.drainTimeoutMs;
    if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs <= 0 || this.drainTimeoutMs > desktopFrameLimits.drainTimeoutMs)
      throw new RangeError("Invalid IPC frame drain timeout");
  }
  header = Buffer.allocUnsafe(4);
  headerBytes = 0;
  size = 0;
  body;
  bodyBytes = 0;
  drainRemaining = 0;
  drainTimer;
  failure;
  drainTimeoutMs;
  push(chunk) {
    if (this.failure) throw this.failure;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.drainRemaining) {
        const count2 = Math.min(this.drainRemaining, chunk.length - offset);
        this.drainRemaining -= count2;
        offset += count2;
        if (!this.drainRemaining) {
          clearTimeout(this.drainTimer);
          this.drainTimer = void 0;
        }
        continue;
      }
      if (!this.size) {
        if (!this.headerBytes && chunk.length - offset >= 4) {
          this.size = chunk.readUInt32LE(offset);
          offset += 4;
        } else {
          const count2 = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count2);
          this.headerBytes += count2;
          offset += count2;
          if (this.headerBytes < 4) return;
          this.size = this.header.readUInt32LE(0);
          this.headerBytes = 0;
        }
        if (!this.size || this.size > desktopFrameLimits.drainedBytes)
          throw new Error("Invalid IPC frame");
        if (this.size > desktopFrameLimits.materializedBytes) {
          if (!this.options.onOversized) throw new Error("Invalid IPC frame");
          const oversized = this.size;
          this.size = 0;
          this.drainRemaining = oversized;
          this.drainTimer = setTimeout(() => {
            this.drainTimer = void 0;
            this.failure = new Error("Oversized IPC frame drain timed out");
            this.options.onError?.(this.failure);
          }, this.drainTimeoutMs);
          this.drainTimer.unref();
          this.options.onOversized(oversized);
          continue;
        }
      }
      const count = Math.min(this.size - this.bodyBytes, chunk.length - offset);
      if (!this.body && count === this.size) {
        const body = chunk.subarray(offset, offset + count);
        offset += count;
        this.size = 0;
        this.accept(body);
      } else {
        if (!count) return;
        this.body ??= Buffer.allocUnsafe(this.size);
        chunk.copy(this.body, this.bodyBytes, offset, offset + count);
        this.bodyBytes += count;
        offset += count;
        if (this.bodyBytes === this.size) {
          const body = this.body;
          this.reset();
          this.accept(body);
        }
      }
    }
  }
  reset() {
    clearTimeout(this.drainTimer);
    this.drainTimer = void 0;
    this.drainRemaining = 0;
    this.failure = void 0;
    this.headerBytes = 0;
    this.size = 0;
    this.body = void 0;
    this.bodyBytes = 0;
  }
};

// packages/codex-adapter/src/desktop-live-window.ts
function boundedItem(item) {
  let budget = 256 * 1024, nodes = 0;
  const seen = /* @__PURE__ */ new WeakSet();
  const fits = (value, depth) => {
    if (++nodes > 8192 || depth > 64 || budget < 0) return false;
    if (typeof value === "string") {
      if (value.length > budget) return false;
      budget -= Buffer.byteLength(value) + 2;
    } else if (value && typeof value === "object") {
      if (seen.has(value)) return false;
      seen.add(value);
      for (const key2 in value) {
        budget -= key2.length + 4;
        if (!fits(value[key2], depth + 1)) return false;
      }
    } else if (value === null || typeof value === "number" || typeof value === "boolean")
      budget -= 8;
    else return false;
    return budget >= 0;
  };
  return Boolean(string(item.id) && string(item.type)) && fits(item, 0) && Buffer.byteLength(JSON.stringify(item)) <= 256 * 1024;
}
var DesktopLiveWindow = class {
  revision = -1;
  receivedAt = 0;
  turns = /* @__PURE__ */ new Map();
  turnIds = /* @__PURE__ */ new Map();
  anchorTurnId;
  seeded = false;
  itemTimes = /* @__PURE__ */ new WeakMap();
  seed(state, revision) {
    this.clear();
    this.revision = revision;
    this.seeded = true;
    const history = object(object(state.turnHistory).history);
    const entities = object(history.entitiesByKey);
    const keys = list(history.islands).flatMap((v) => list(object(v).entries).map((v2) => string(object(v2).value))).slice(-2);
    for (const key2 of keys) {
      const turn = object(entities[key2]);
      if (!string(turn.turnId)) continue;
      const items = /* @__PURE__ */ new Map(), values = list(turn.items);
      for (let index = Math.max(0, values.length - 30); index < values.length; index++) {
        const item = object(values[index]);
        if (boundedItem(item)) {
          items.set(index, item);
          this.itemTimes.set(item, 0);
        }
      }
      this.turns.set(key2, items);
      this.turnIds.set(key2, string(turn.turnId));
      this.anchorTurnId = string(turn.turnId);
    }
  }
  clear() {
    this.revision = -1;
    this.receivedAt = 0;
    this.turns.clear();
    this.turnIds.clear();
    this.anchorTurnId = void 0;
    this.seeded = false;
  }
  apply(change) {
    const revision = change.revision, base = change.baseRevision;
    if (change.type !== "patches" || !Number.isSafeInteger(revision) || !Number.isSafeInteger(base) || Number(revision) <= Number(base))
      return;
    if (Number(revision) <= this.revision) return;
    if (this.revision !== Number(base)) {
      this.turns.clear();
      this.turnIds.clear();
      this.seeded = false;
    }
    this.revision = Number(revision);
    this.receivedAt = Date.now();
    for (const value of list(change.patches)) {
      const patch = object(value), path = list(patch.path);
      if (path.length < 4 || path[0] !== "turnHistory" || path[1] !== "history" || path[2] !== "entitiesByKey" || typeof path[3] !== "string")
        continue;
      const turnId = path[3];
      if (turnId.length > 256 || ["__proto__", "prototype", "constructor"].includes(turnId))
        continue;
      if (path.length === 4 && ["add", "replace"].includes(string(patch.op))) {
        const turn = object(patch.value);
        if (!string(turn.turnId) || !Array.isArray(turn.items)) continue;
        this.turnIds.set(turnId, string(turn.turnId));
        const items2 = /* @__PURE__ */ new Map();
        for (let index2 = Math.max(0, turn.items.length - 30); index2 < turn.items.length; index2++) {
          const item = object(turn.items[index2]);
          if (boundedItem(item)) {
            items2.set(index2, item);
            this.itemTimes.set(item, this.receivedAt);
          }
        }
        this.turns.set(turnId, items2);
        continue;
      }
      if (path.length === 5 && path[4] === "items" && ["add", "replace"].includes(string(patch.op)) && Array.isArray(patch.value)) {
        const items2 = /* @__PURE__ */ new Map();
        for (let index2 = Math.max(0, patch.value.length - 30); index2 < patch.value.length; index2++) {
          const item = object(patch.value[index2]);
          if (boundedItem(item)) {
            items2.set(index2, item);
            this.itemTimes.set(item, this.receivedAt);
          }
        }
        this.turns.set(turnId, items2);
        continue;
      }
      if (path.length < 6 || path[4] !== "items" || !Number.isSafeInteger(path[5]) || Number(path[5]) < 0)
        continue;
      let items = this.turns.get(turnId);
      if (!items) {
        items = /* @__PURE__ */ new Map();
        this.turns.set(turnId, items);
      }
      const index = Number(path[5]);
      if (path.length === 6 && ["add", "remove"].includes(string(patch.op))) {
        const shifted = /* @__PURE__ */ new Map();
        for (const [key2, item] of items) {
          if (patch.op === "remove" && key2 === index) continue;
          shifted.set(key2 >= index ? key2 + (patch.op === "add" ? 1 : -1) : key2, item);
        }
        items = shifted;
        this.turns.set(turnId, items);
      }
      if (path.length === 6) {
        if (["add", "replace"].includes(string(patch.op))) {
          const item = object(patch.value);
          if (boundedItem(item)) {
            items.set(index, item);
            this.itemTimes.set(item, this.receivedAt);
          } else items.delete(index);
        }
      } else if (items.has(index)) {
        try {
          const item = applyDesktopPatches(items.get(index), [{ ...patch, path: path.slice(6) }]);
          if (!boundedItem(item)) items.delete(index);
          else {
            items.set(index, item);
            this.itemTimes.set(item, this.receivedAt);
          }
        } catch {
          items.delete(index);
        }
      }
      while (items.size > 30) items.delete(Math.min(...items.keys()));
    }
    while (this.turns.size > 2) {
      const first = this.turns.keys().next().value;
      this.turns.delete(first);
      this.turnIds.delete(first);
    }
    return this.observation();
  }
  observation() {
    if (!this.receivedAt) return;
    return {
      revision: this.revision,
      receivedAt: this.receivedAt,
      seeded: this.seeded,
      items: [...this.turns].flatMap(
        ([turnId, items]) => !this.turnIds.has(turnId) ? [] : [...items].sort(([a], [b]) => a - b).map(([, item]) => ({
          turnId: this.turnIds.get(turnId),
          item,
          receivedAt: this.itemTimes.get(item)
        }))
      )
    };
  }
  /** Bind through exact item IDs, never text or array position. */
  bind(messages) {
    const tip = messages.at(-1)?.runId;
    if (tip && this.anchorTurnId && tip !== this.anchorTurnId && ![...this.turnIds.values()].includes(tip))
      this.clear();
    if (tip) this.anchorTurnId = tip;
    const ids = new Map(messages.filter((v) => v.runId).map((v) => [v.id, v.runId]));
    for (const [key2, items] of this.turns) {
      const candidates = new Set(
        [...items.values()].map((item) => ids.get(string(item.id))).filter(Boolean)
      );
      if (candidates.size === 1) {
        const turn = [...candidates][0];
        if (!this.turnIds.has(key2) || this.turnIds.get(key2) === turn) this.turnIds.set(key2, turn);
        else {
          this.turns.delete(key2);
          this.turnIds.delete(key2);
        }
      } else if (candidates.size > 1) {
        this.turns.delete(key2);
        this.turnIds.delete(key2);
      }
    }
  }
};

// packages/codex-adapter/src/desktop-platform.ts
import { execFileSync, spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duplex } from "node:stream";

// packages/codex-adapter/src/desktop-private-state-native.ts
import {
  Worker as Worker2,
  MessageChannel,
  MessagePort,
  isMainThread as isMainThread2,
  parentPort,
  postMessageToThread
} from "node:worker_threads";
var privateStateProtocol = Object.freeze({
  words: 6,
  responseBytes: 256,
  pathBytes: 128 * 1024,
  pathCharacters: 32767,
  frameBytes: 2 * Math.ceil(128 * 1024 / 3) * 4 + 64,
  startupMs: 3e4,
  operationMs: 5e3,
  closeMs: 1e3,
  state: 0,
  result: 1,
  request: 2,
  response: 3,
  length: 4,
  pid: 5,
  starting: 0,
  ready: 1,
  failed: -1,
  closing: 2,
  gone: 3,
  waiting: 0,
  ok: 1,
  rejected: 2
});
var bootstrapArguments = /* @__PURE__ */ new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--eval",
  "-e",
  "--print",
  "-p",
  "--input-type"
]);
var preloadArguments = /* @__PURE__ */ new Set([
  ...bootstrapArguments,
  "--test-concurrency",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-shard",
  "--test-timeout",
  "--test-isolation",
  "--watch-path"
]);
var inheritedValueArguments = /* @__PURE__ */ new Set([
  "--disable-proto",
  "--title",
  "--max-old-space-size",
  "--max-semi-space-size",
  "--stack-size",
  "--stack-trace-limit",
  "--tls-cipher-list",
  "--use-largepages",
  "--secure-heap-min",
  "--secure-heap",
  "--v8-pool-size",
  "--trace-event-file-pattern"
]);
var inheritedSwitches = /* @__PURE__ */ new Set([
  "--disallow-code-generation-from-strings",
  "--abort-on-uncaught-exception",
  "--jitless",
  "--expose-gc",
  "--use-strict",
  "--node-snapshot"
]);
function privateStateExecArgv(args, inherited = true) {
  const kept = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const name = argument.split("=")[0].replaceAll("_", "-");
    if (inherited && inheritedValueArguments.has(name)) {
      if (!argument.includes("=")) index++;
      continue;
    }
    if (inherited && inheritedSwitches.has(name)) continue;
    if (preloadArguments.has(argument)) {
      index++;
      continue;
    }
    if (preloadArguments.has(argument.split("=")[0]) || /^-[rep].+/.test(argument) || /^--(?:test(?:-|=|$)|watch(?:-|=|$)|check$)/.test(argument) || argument === "-c") {
      if (/^--test-/.test(argument) && !argument.includes("=") && args[index + 1]?.[0] !== "-")
        index++;
      continue;
    }
    kept.push(argument);
  }
  return kept;
}
function privateStateNodeOptions(value = "", inherited = false) {
  const args = [];
  let word = "", quoted = false, escaped = false;
  for (const character of value) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (/\s/.test(character) && !quoted) {
      if (word) args.push(word);
      word = "";
    } else word += character;
  }
  if (quoted || escaped) throw new Error("Invalid private state Node options");
  if (word) args.push(word);
  return privateStateExecArgv(args, inherited).map((argument) => JSON.stringify(argument)).join(" ");
}
function privateStatePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= privateStateProtocol.pathCharacters && !value.includes("\0") && Buffer.byteLength(value) <= privateStateProtocol.pathBytes && Buffer.from(value).toString("utf8") === value;
}
function privateStateWorkerOptions() {
  return {
    // Let Node inherit its supported isolate options rather than re-submit all
    // reflected process defaults. Override only to prevent recursive bootstrap.
    execArgv: process.execArgv.some(
      (argument) => bootstrapArguments.has(argument.split("=")[0]) || /^-[rep].+/.test(argument)
    ) ? privateStateExecArgv(process.execArgv) : void 0,
    env: { ...process.env, NODE_OPTIONS: privateStateNodeOptions(process.env.NODE_OPTIONS, true) }
  };
}
function failPrivateState(control) {
  const p = privateStateProtocol;
  for (; ; ) {
    const state = Atomics.load(control, p.state);
    if (state === p.gone) break;
    if (Atomics.compareExchange(control, p.state, state, p.failed) === state) break;
  }
  Atomics.store(control, p.result, p.failed);
  Atomics.notify(control, p.state);
  Atomics.notify(control, p.result);
}
var supervisorKey = Symbol.for("codex-manage.windows-private-state-supervisor.v1");
function registerFixedNativeTransport(kind) {
  if (!isMainThread2) return;
  const globals2 = globalThis;
  const supervisor = globals2[supervisorKey] ??= {
    starts: /* @__PURE__ */ new Map(),
    workers: /* @__PURE__ */ new Set(),
    retiring: /* @__PURE__ */ new WeakSet()
  };
  if (!supervisor.starts.size) {
    process.on("workerMessage", (request, source) => {
      if (source <= 0) return;
      if (request?.kind === "windows-private-state-start")
        supervisor.starts.get(request.module)?.(request, source);
      else if (request?.kind === "windows-trace-start")
        supervisor.starts.get("trace:" + request.module)?.(request, source);
    });
    process.on("beforeExit", () => {
      const p = privateStateProtocol;
      const workers = [...supervisor.workers];
      const deadline = performance.now() + p.closeMs;
      for (const { worker, control } of workers) {
        failPrivateState(control);
        worker.postMessage({ kind: "close" });
      }
      for (const { control } of workers) {
        for (; ; ) {
          const state = Atomics.load(control, p.state);
          if (state === p.gone || performance.now() >= deadline) break;
          Atomics.wait(control, p.state, state, deadline - performance.now());
        }
      }
    });
  }
  const key2 = kind === "windows-trace-start" ? "trace:" + import.meta.url : import.meta.url;
  if (supervisor.starts.has(key2)) return;
  supervisor.starts.set(key2, (request, source) => {
    const p = privateStateProtocol;
    if (!(request.ownerPort instanceof MessagePort) || !(request.shared instanceof SharedArrayBuffer) || request.shared.byteLength !== p.words * 4 + p.responseBytes)
      return;
    const control = new Int32Array(request.shared, 0, p.words);
    const trace = kind === "windows-trace-start" ? request.trace : void 0;
    const fields = ["kind", "module", "shared", "ownerPort", ...trace ? ["trace"] : []];
    if (request.kind !== kind || Object.keys(request).some((key3) => !fields.includes(key3)) || kind === "windows-trace-start" && (!trace || Object.keys(trace).some((key3) => !["identity", "root", "response"].includes(key3)) || !privateStatePath(trace.root) || !trace.identity || Object.keys(trace.identity).some(
      (key3) => !["pid", "startedAtUnixMs", "executable"].includes(key3)
    ) || !Number.isSafeInteger(trace.identity.pid) || trace.identity.pid <= 0 || !Number.isSafeInteger(trace.identity.startedAtUnixMs) || trace.identity.startedAtUnixMs <= 0 || !privateStatePath(trace.identity.executable) || !(trace.response instanceof SharedArrayBuffer) || trace.response.byteLength !== 48 * 1024 * 1024 + 8) || Atomics.load(control, p.state) !== p.starting || Atomics.compareExchange(control, p.request, 0, -1) !== 0) {
      request.ownerPort.close();
      return;
    }
    try {
      const owner = getWindowsProcessWorker(source);
      if (!owner) throw new Error("Registered native transport owner required");
      if (supervisor.retiring.has(owner)) throw new Error("Native owner is retiring");
      const entry = new URL(
        trace ? "./desktop-trace-native-worker.js" : "./desktop-private-state-native-worker.js",
        import.meta.url
      );
      const options = privateStateWorkerOptions();
      if (Atomics.load(control, p.state) !== p.starting)
        throw new Error("Private state owner closed before startup");
      const worker = new Worker2(entry, {
        ...options,
        workerData: {
          kind: trace ? "windows-trace-native" : "windows-private-state",
          entryURL: entry.href,
          windowsProcessGate: getWindowsProcessGate(),
          shared: trace?.response ?? request.shared,
          ownerPort: request.ownerPort,
          ...trace ? { identity: trace.identity, root: trace.root, lifecycle: request.shared } : {}
        },
        transferList: [request.ownerPort]
      });
      let resolveExit;
      const exited = new Promise((resolve) => {
        resolveExit = resolve;
      });
      const record = { worker, owner, control, exited };
      registerWindowsProcessWorker(worker);
      supervisor.workers.add(record);
      const ownerExited = () => {
        failPrivateState(control);
        worker.postMessage({ kind: "close" });
      };
      owner.prependOnceListener("exit", ownerExited);
      worker.on("error", () => failPrivateState(control));
      worker.once("exit", () => {
        owner.removeListener("exit", ownerExited);
        const reaped = Atomics.load(control, p.state) === p.gone;
        failPrivateState(control);
        if (!Atomics.load(control, p.pid)) {
          Atomics.store(control, p.state, p.gone);
          Atomics.notify(control, p.state);
        }
        const complete = reaped || !Atomics.load(control, p.pid);
        if (complete) supervisor.workers.delete(record);
        resolveExit(complete);
      });
      worker.unref();
    } catch {
      failPrivateState(control);
      Atomics.store(control, p.state, p.gone);
      Atomics.notify(control, p.state);
      request.ownerPort.close();
    }
  });
}
registerFixedNativeTransport("windows-private-state-start");

// packages/codex-adapter/src/desktop-platform.ts
var windowsDesktopPipe = String.raw`\\.\pipe\codex-ipc`;
var windowsHelper = (name) => fileURLToPath(new URL("../windows/" + name, import.meta.url));
var powershell = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
function windowsPowerShellEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key2]) => key2.toUpperCase() !== "PSMODULEPATH")
  );
}
async function openWindowsDesktopPipe(identity) {
  let startupMs = 3e4;
  const child = withWindowsProcessCreation(startupMs, (remaining) => {
    startupMs = remaining;
    return spawn(
      powershell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsHelper("desktop-pipe.ps1"),
        "-Action",
        "bridge",
        "-ExpectedDesktop",
        identity.executable,
        "-ExpectedSha256",
        identity.executableSha256
      ],
      { stdio: "pipe", windowsHide: true, env: windowsPowerShellEnvironment() }
    );
  });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  stream.on("close", () => child.kill());
  child.on("exit", () => stream.destroy());
  child.on("error", () => stream.destroy());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows desktop pipe timed out"));
    }, startupMs);
    let stderr = "";
    const fail = () => {
      clearTimeout(timer);
      const code = stderr.match(
        /^(WINDOWS_POWERSHELL_MODULE_UNAVAILABLE|WINDOWS_DESKTOP_NOT_RUNNING)\s*$/m
      )?.[1] ?? "WINDOWS_DESKTOP_PIPE_REJECTED";
      reject(Object.assign(new Error("Windows desktop pipe identity rejected"), { code }));
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      if (stderr.split(/\r?\n/).includes("CODEX_MANAGE_PIPE_READY")) {
        clearTimeout(timer);
        child.removeListener("error", fail);
        child.removeListener("exit", fail);
        resolve();
      }
    });
  });
  return stream;
}

// packages/codex-adapter/src/desktop-ipc.ts
var desktopProfile = { version: "26.1002.52244", streamVersion: 11 };
var versions = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-update-thread-settings": 2,
  "thread-follower-read-model-settings": 1
};
var DesktopRequestTimeout = class extends Error {
  constructor() {
    super("Desktop request outcome uncertain");
  }
};
var DesktopCommandNotSubmitted = class extends CodexRejection {
  constructor(message, ownerUnavailable = false) {
    super(message);
    this.ownerUnavailable = ownerUnavailable;
  }
};
function applyDesktopPatches(state, patches) {
  const next = { ...state };
  const copies = new WeakSet([next]);
  for (const value of patches) {
    const patch = object(value);
    const path = list(patch.path);
    if (!path.length || path.length > 128 || path.some(
      (p) => !(typeof p === "string" || typeof p === "number" && Number.isSafeInteger(p) && p >= 0) || ["__proto__", "prototype", "constructor"].includes(String(p))
    ))
      throw new Error("Invalid desktop patch path");
    if (!["add", "replace", "remove"].includes(string(patch.op)))
      throw new Error("Invalid desktop patch operation");
    let parent = next;
    for (const key3 of path.slice(0, -1)) {
      if (!Object.hasOwn(parent, String(key3))) throw new Error("Missing desktop patch parent");
      let child = parent[String(key3)];
      if (!child || typeof child !== "object") throw new Error("Invalid desktop patch parent");
      if (!copies.has(child)) {
        child = Array.isArray(child) ? child.slice() : { ...child };
        parent[String(key3)] = child;
        copies.add(child);
      }
      parent = child;
    }
    const key2 = path.at(-1);
    if (Array.isArray(parent)) {
      if (typeof key2 !== "number" || key2 > parent.length || patch.op !== "add" && key2 === parent.length)
        throw new Error("Invalid desktop array index");
      if (patch.op === "add") parent.splice(key2, 0, patch.value);
      else if (patch.op === "remove") parent.splice(key2, 1);
      else parent[key2] = patch.value;
    } else if (patch.op === "remove") delete parent[String(key2)];
    else parent[String(key2)] = patch.value;
  }
  return next;
}
function desktopTurns(state) {
  const history = object(object(state.turnHistory).history);
  if (object(state.turnHistory).kind !== "canonical") return list(state.turns).map(object);
  const entities = object(history.entitiesByKey);
  return list(history.islands).flatMap(
    (island) => list(object(island).entries).map((entry) => object(entities[string(object(entry).value)]))
  );
}
function desktopStreamHead(state) {
  const turnId = string(desktopTurns(state).at(-1)?.turnId);
  const inputId = string(state.latestTurnStartMessageId);
  return turnId && inputId ? { turnId, key: JSON.stringify([inputId, turnId]) } : void 0;
}
function continuedDesktopStream(previous, next) {
  const prior = desktopStreamHead(previous);
  const head = desktopStreamHead(next);
  if (!prior || !head || prior.key === head.key || previous.latestTurnStartMessageId === next.latestTurnStartMessageId)
    return;
  const turns = desktopTurns(next);
  const anchor = turns.findIndex((turn) => turn.turnId === prior.turnId);
  if (anchor >= 0 && anchor < turns.length - 1 && ["completed", "failed", "interrupted"].includes(string(turns[anchor]?.status)))
    return prior;
}
function terminalDesktopHead(state) {
  const head = desktopStreamHead(state);
  const turns = desktopTurns(state);
  const status = string(turns.at(-1)?.status);
  return head && ["completed", "failed", "interrupted"].includes(status) && ["idle", "systemError"].includes(string(object(state.threadRuntimeStatus).type)) && !turns.some((turn) => turn.status === "inProgress") ? { ...head, status } : void 0;
}
function terminalDesktopReset(previous, next) {
  const prior = desktopStreamHead(previous);
  const head = terminalDesktopHead(next);
  return prior && head && prior.key === head.key && desktopTurns(previous).at(-1)?.status === "inProgress" ? head : void 0;
}
function retireRevision(reset, revision) {
  reset.retiredRevisions.add(revision);
  while (reset.retiredRevisions.size > 64)
    reset.retiredRevisions.delete(reset.retiredRevisions.values().next().value);
}
var DesktopIpc = class {
  constructor(path, frameOptions = {}) {
    this.path = path;
    this.frameOptions = frameOptions;
  }
  socket;
  windowsIdentity;
  clientId = "";
  pending = /* @__PURE__ */ new Map();
  owners = /* @__PURE__ */ new Map();
  states = /* @__PURE__ */ new Map();
  // One owner can publish both a retired cached stream and its replacement.
  // Revisions are comparable within a stream, not across those two histories.
  retiredStreams = /* @__PURE__ */ new Map();
  // A stop can rebuild the same input/turn at revision 2. Its terminal
  // evidence must also fence the old running stream, whose head ID is equal.
  terminalResets = /* @__PURE__ */ new Map();
  waiters = /* @__PURE__ */ new Map();
  follows = /* @__PURE__ */ new Map();
  skippedFrames = 0;
  snapshotReads = /* @__PURE__ */ new Map();
  limitedReads = /* @__PURE__ */ new Map();
  snapshotReceivedAt = /* @__PURE__ */ new Map();
  snapshotRetryAt = /* @__PURE__ */ new Map();
  liveWindows = /* @__PURE__ */ new Map();
  observedOwners = /* @__PURE__ */ new Map();
  currentModels = /* @__PURE__ */ new Map();
  modelReads = /* @__PURE__ */ new Map();
  modelEpoch = 0;
  ready = false;
  onSnapshot = () => {
  };
  onUnavailable = () => {
  };
  onDiscovered = () => {
  };
  onObservation = () => {
  };
  onModelSettings = () => {
  };
  onDisconnect = () => {
  };
  async connect() {
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      const dir = lstatSync(dirname2(this.path)), file = lstatSync(this.path);
      if (uid === void 0 || dir.uid !== uid || file.uid !== uid || !dir.isDirectory() || !file.isSocket() || dir.mode & 18 || file.mode & 63)
        throw new Error("Desktop IPC must be a private socket owned by this user");
    } else if (this.path !== windowsDesktopPipe || !this.windowsIdentity) {
      throw new Error("Verified Windows desktop named pipe required");
    }
    const socket = process.platform === "win32" ? await openWindowsDesktopPipe(this.windowsIdentity) : connect(this.path);
    this.socket = socket;
    const frames = new DesktopFrameDecoder(
      (body) => {
        this.receive(object(JSON.parse(body.toString("utf8"))));
      },
      {
        ...this.frameOptions,
        onOversized: () => {
          this.skippedFrames++;
        },
        onError: () => socket.destroy()
      }
    );
    socket.on("data", (chunk) => {
      if (socket !== this.socket || socket.destroyed) return;
      try {
        frames.push(chunk);
      } catch {
        frames.reset();
        socket.destroy();
      }
    });
    socket.on("error", () => {
    });
    socket.on("close", () => {
      frames.reset();
      if (socket !== this.socket) return;
      this.ready = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Desktop disconnected; outcome uncertain"));
      }
      this.pending.clear();
      this.owners.clear();
      this.states.clear();
      this.retiredStreams.clear();
      this.terminalResets.clear();
      this.snapshotReads.clear();
      this.snapshotRetryAt.clear();
      this.liveWindows.clear();
      this.observedOwners.clear();
      this.currentModels.clear();
      this.modelEpoch++;
      for (const waiters of this.waiters.values()) for (const done of waiters) done();
      this.onDisconnect();
    });
    if (process.platform !== "win32")
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    const initialized = await this.request("initialize", { clientType: "codex-manage" });
    this.clientId = string(object(initialized.result).clientId);
    if (!this.clientId) throw new Error("Desktop IPC initialization failed");
    this.ready = true;
  }
  write(message, beforeExecutionWrite) {
    if (!this.socket || this.socket.destroyed)
      throw new DesktopCommandNotSubmitted("Desktop IPC unavailable");
    const bytes = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    const frame = Buffer.concat([header, bytes]);
    beforeExecutionWrite?.();
    this.socket.write(frame);
  }
  request(method, params, targetClientId, timeoutMs = 15e3, beforeExecutionWrite) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DesktopRequestTimeout());
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.write(
          {
            type: "request",
            requestId,
            sourceClientId: this.clientId,
            version: versions[method] ?? 0,
            method,
            params,
            timeoutMs,
            ...targetClientId ? { targetClientId } : {}
          },
          beforeExecutionWrite
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("IPC write failed"));
      }
    });
  }
  receive(message) {
    if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      });
    } else if (message.type === "response") {
      const call = this.pending.get(string(message.requestId));
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(string(message.requestId));
      if (message.resultType === "success") call.resolve(message);
      else call.reject(new CodexRejection(string(message.error) || "Desktop rejected request"));
    } else if (message.type === "broadcast") {
      const params = object(message.params);
      if (message.method === "thread-read-state-changed") {
        const id2 = string(params.conversationId);
        if (message.version === 3 && params.hostId === "local" && id2 && typeof params.hasUnreadTurn === "boolean") {
          this.refreshSnapshot(id2);
        }
        return;
      }
      if (message.method === "client-status-changed" && params.status === "disconnected") {
        this.modelEpoch++;
        for (const [id2, settings] of this.currentModels)
          if (settings.owner === params.clientId) {
            this.currentModels.delete(id2);
            this.onModelSettings(id2);
          }
        for (const [id2, owner] of this.owners)
          if (owner === params.clientId) {
            this.owners.delete(id2);
            this.states.delete(id2);
            this.retiredStreams.delete(id2);
            this.terminalResets.delete(id2);
            this.liveWindows.delete(id2);
            this.observedOwners.delete(id2);
            this.onUnavailable(id2);
          }
      }
      if (message.method !== "thread-stream-state-changed" || params.hostId !== "local") return;
      const id = string(params.conversationId), change = object(params.change);
      if (this.owners.get(id) !== message.sourceClientId) {
        if (message.version === desktopProfile.streamVersion && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
          this.onDiscovered(id);
        return;
      }
      if (message.version !== desktopProfile.streamVersion) {
        this.invalidate(id);
        return;
      }
      const revision = change.revision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision)) {
        this.invalidate(id);
        return;
      }
      const old = this.states.get(id);
      let terminalReset;
      if (change.type === "patches" && !old) {
        const window2 = this.liveWindows.get(id) ?? new DesktopLiveWindow();
        this.liveWindows.set(id, window2);
        while (this.liveWindows.size > 32) {
          const oldest = this.liveWindows.keys().next().value;
          this.liveWindows.delete(oldest);
          this.observedOwners.delete(oldest);
        }
        const observation = window2.apply(change);
        if (observation) this.onObservation(id, observation);
        this.following(id);
        return;
      }
      if (change.type === "snapshot") {
        const state2 = object(change.conversationState);
        if (state2.id !== id || state2.hostId !== "local") {
          this.invalidate(id);
          return;
        }
        const head2 = desktopStreamHead(state2);
        const reset2 = head2 && this.terminalResets.get(id)?.get(head2.key);
        if (reset2 && terminalDesktopHead(state2)?.status !== reset2.status) {
          retireRevision(reset2, revision);
          return;
        }
        const retired = this.retiredStreams.get(id);
        if (head2 && retired?.has(head2.key)) {
          retired.set(head2.key, Math.max(retired.get(head2.key), revision));
          return;
        }
        if (old) {
          if (revision < old.revision) {
            terminalReset = terminalDesktopReset(old.state, state2);
            if (!terminalReset && !continuedDesktopStream(old.state, state2)) return;
          }
        }
      } else if (change.type === "patches" && old?.revision !== change.baseRevision) {
        const reset2 = [...this.terminalResets.get(id)?.values() ?? []].find(
          (value) => value.retiredRevisions.has(change.baseRevision)
        );
        if (reset2 && typeof change.baseRevision === "number" && revision > change.baseRevision) {
          retireRevision(reset2, revision);
          return;
        }
        const retired = this.retiredStreams.get(id);
        const stream = [...retired ?? []].find(([, value]) => value === change.baseRevision);
        if (stream && typeof change.baseRevision === "number" && revision > change.baseRevision) {
          retired.set(stream[0], revision);
          return;
        }
      }
      if (old && change.type !== "snapshot" && revision < old.revision) return;
      if (old && change.type === "patches" && revision === old.revision) return;
      let state;
      if (change.type === "snapshot") state = object(change.conversationState);
      else if (change.type === "patches" && old !== void 0 && old?.revision === change.baseRevision && revision > old.revision) {
        try {
          state = applyDesktopPatches(old.state, list(change.patches));
        } catch {
          this.invalidate(id);
          this.following(id);
          return;
        }
      } else {
        this.invalidate(id);
        this.following(id);
        return;
      }
      if (state.id !== id || state.hostId !== "local") {
        this.invalidate(id);
        return;
      }
      const resets = this.terminalResets.get(id);
      const head = resets && desktopStreamHead(state);
      const reset = head && resets.get(head.key);
      if (reset && terminalDesktopHead(state)?.status !== reset.status) {
        retireRevision(reset, revision);
        return;
      }
      if (terminalReset && old) {
        const resets2 = this.terminalResets.get(id) ?? /* @__PURE__ */ new Map();
        resets2.set(terminalReset.key, {
          status: terminalReset.status,
          retiredRevisions: /* @__PURE__ */ new Set([old.revision])
        });
        while (resets2.size > 32) resets2.delete(resets2.keys().next().value);
        this.terminalResets.set(id, resets2);
      }
      const continued = old && continuedDesktopStream(old.state, state);
      if (continued) {
        const streams = this.retiredStreams.get(id) ?? /* @__PURE__ */ new Map();
        streams.set(continued.key, old.revision);
        this.retiredStreams.set(id, streams);
      }
      this.states.set(id, { revision, state });
      this.currentModels.delete(id);
      const existingWindow = this.liveWindows.get(id);
      const window = existingWindow ?? new DesktopLiveWindow();
      if (change.type === "snapshot" || !existingWindow) window.seed(state, revision);
      else window.apply(change);
      this.liveWindows.delete(id);
      this.liveWindows.set(id, window);
      while (this.liveWindows.size > 32) {
        const oldest = this.liveWindows.keys().next().value;
        this.liveWindows.delete(oldest);
        this.observedOwners.delete(oldest);
      }
      this.snapshotReceivedAt.set(id, Date.now());
      this.snapshotRetryAt.delete(id);
      this.limitedReads.delete(id);
      this.onSnapshot(id, state);
      for (const done of this.waiters.get(id) ?? []) done();
    }
  }
  invalidate(id) {
    this.states.delete(id);
    this.onUnavailable(id);
  }
  deferSnapshot(id, milliseconds) {
    this.snapshotRetryAt.set(id, Date.now() + milliseconds);
    while (this.snapshotRetryAt.size > 2048)
      this.snapshotRetryAt.delete(this.snapshotRetryAt.keys().next().value);
  }
  following(id, force = false) {
    const owner = this.owners.get(id);
    if (!owner || !this.ready) return;
    if ((this.limitedReads.get(id) ?? 0) > Date.now()) return;
    if (!force && !this.states.has(id) && (this.snapshotRetryAt.get(id) ?? 0) > Date.now()) return;
    const started = this.snapshotReads.get(id);
    if (started !== void 0 && started !== this.skippedFrames && !this.states.has(id)) return;
    if (!this.states.has(id)) this.deferSnapshot(id, 5e3);
    this.write({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: this.clientId,
      targetClientIds: [owner],
      params: { hostId: "local", conversationId: id, following: true }
    });
  }
  hasOwner(id) {
    return this.ready && this.states.has(id) && this.owners.has(id);
  }
  /** Refresh original desktop metadata after confirming an explicitly opened thread is unarchived.
   * This versioned lifecycle hint neither claims ownership nor submits a model turn.
   */
  refreshUnarchivedThread(id) {
    if (!this.ready || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
      throw new DesktopCommandNotSubmitted("\u539F\u684C\u9762\u5143\u6570\u636E\u540C\u6B65\u76EE\u6807\u4E0D\u53EF\u7528");
    this.write({
      type: "broadcast",
      method: "thread-unarchived",
      version: 1,
      sourceClientId: this.clientId,
      params: { hostId: "local", conversationId: id }
    });
  }
  state(id) {
    return this.states.get(id)?.state;
  }
  modelSettings(id) {
    const value = this.currentModels.get(id);
    if (!this.ready || !value || Date.now() - value.checkedAt >= 1e4) return;
    if (this.owners.has(id) && this.owners.get(id) !== value.owner) return;
    return { model: value.model, effort: value.effort };
  }
  /** Current owner settings are readable even when its full transcript is too large.
   * This read never opens a thread, claims execution ownership, or grants control.
   */
  async refreshModelSettings(id) {
    if (!this.ready) return;
    if (Date.now() - (this.currentModels.get(id)?.checkedAt ?? 0) < 5e3) return;
    const pending = this.modelReads.get(id);
    if (pending) return pending;
    const socket = this.socket;
    const epoch = this.modelEpoch;
    const work = (async () => {
      try {
        const discovery = await this.request(
          "thread-owner-discovery",
          { hostId: "local", conversationId: id },
          void 0,
          2e3
        );
        const owner = string(discovery.handledByClientId);
        if (!owner || object(discovery.result).supportsUntrustedAppInput !== true)
          throw new Error("Model settings owner unavailable");
        if (this.owners.has(id) && this.owners.get(id) !== owner)
          throw new Error("Model settings owner changed");
        const state = this.state(id);
        const result = await this.request(
          "thread-follower-read-model-settings",
          { conversationId: id },
          owner,
          2e3
        );
        if (!this.ready || this.socket !== socket || this.modelEpoch !== epoch || result.handledByClientId !== owner || result.method !== "thread-follower-read-model-settings" || this.owners.has(id) && this.owners.get(id) !== owner)
          throw new Error("Model settings response mismatch");
        if (this.state(id) !== state) return;
        this.recordModelSettings(id, owner, object(object(result.result).settings));
      } catch {
        if (this.currentModels.delete(id)) this.onModelSettings(id);
      }
    })();
    this.modelReads.set(id, work);
    try {
      await work;
    } finally {
      if (this.modelReads.get(id) === work) this.modelReads.delete(id);
    }
  }
  recordModelSettings(id, owner, settings) {
    if (!string(settings.model) || !(typeof settings.reasoningEffort === "string" || settings.reasoningEffort === null))
      throw new Error("Incomplete model settings");
    const previous = this.modelSettings(id);
    this.currentModels.delete(id);
    this.currentModels.set(id, {
      owner,
      checkedAt: Date.now(),
      model: string(settings.model),
      effort: settings.reasoningEffort
    });
    while (this.currentModels.size > 128)
      this.currentModels.delete(this.currentModels.keys().next().value);
    if (previous?.model !== settings.model || previous?.effort !== settings.reasoningEffort)
      this.onModelSettings(id);
  }
  observation(id) {
    if (!this.ready || Date.now() - (this.observedOwners.get(id) ?? 0) >= 1e4) return;
    return this.liveWindows.get(id)?.observation();
  }
  bindObservation(id, messages) {
    this.liveWindows.get(id)?.bind(messages);
  }
  /** Small, read-only owner heartbeat. Does not grant hasOwner/control status. */
  async refreshObservation(id) {
    if (!this.liveWindows.has(id) || !this.ready || this.hasOwner(id)) return;
    if (Date.now() - (this.observedOwners.get(id) ?? 0) < 5e3) return;
    const previous = this.owners.get(id);
    try {
      const discovery = await this.request(
        "thread-owner-discovery",
        { hostId: "local", conversationId: id },
        void 0,
        2e3
      );
      const owner = string(discovery.handledByClientId);
      if (!owner || owner !== previous || object(discovery.result).supportsUntrustedAppInput !== true)
        throw new Error("Observation owner changed");
      const result = await this.request(
        "thread-follower-read-model-settings",
        { conversationId: id },
        owner,
        2e3
      );
      if (this.owners.get(id) !== owner || result.handledByClientId !== owner || result.method !== "thread-follower-read-model-settings" || !object(result.result).settings)
        throw new Error("Observation owner response mismatch");
      this.observedOwners.set(id, Date.now());
      this.recordModelSettings(id, owner, object(object(result.result).settings));
    } catch {
      this.observedOwners.delete(id);
      this.liveWindows.delete(id);
    }
  }
  refreshSnapshot(id, force = true) {
    if (this.hasOwner(id) && (force || Date.now() - (this.snapshotReceivedAt.get(id) ?? 0) >= 1e4))
      this.following(id);
  }
  /** Read through the exact owner; loading old pages never submits model input. */
  async completeHistory(id) {
    const result = await this.command(id, "thread-follower-load-complete-history", {});
    const revision = result.revision ?? object(result.result).revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision))
      throw new Error("Desktop history revision unavailable");
    if ((this.states.get(id)?.revision ?? -1) < revision) {
      await new Promise((resolve, reject) => {
        const waiting = this.waiters.get(id) ?? /* @__PURE__ */ new Set();
        const done = () => {
          if ((this.states.get(id)?.revision ?? -1) < revision) return;
          clearTimeout(timer);
          waiting.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          waiting.delete(done);
          reject(new Error("Desktop complete history snapshot unavailable"));
        }, 5e3);
        waiting.add(done);
        this.waiters.set(id, waiting);
        done();
      });
    }
    const state = this.state(id);
    if (!this.hasOwner(id) || state?.id !== id || state.hostId !== "local")
      throw new Error("Desktop history owner unavailable");
    return state;
  }
  async follow(id, discoveryTimeoutMs = 15e3, revalidateOwner = false) {
    if ((this.limitedReads.get(id) ?? 0) > Date.now() && !this.hasOwner(id))
      return this.snapshotUnavailable();
    if (!revalidateOwner && !this.hasOwner(id) && (this.snapshotRetryAt.get(id) ?? 0) > Date.now())
      return void 0;
    if (!revalidateOwner && this.hasOwner(id)) return this.state(id);
    const pending = this.follows.get(id);
    if (pending) {
      const state = await pending.work;
      if (revalidateOwner && !pending.revalidateOwner)
        return this.follow(id, discoveryTimeoutMs, true);
      if (state || pending.timeoutMs >= discoveryTimeoutMs) return state;
      return this.follow(id, discoveryTimeoutMs, revalidateOwner);
    }
    const work = this.followNow(id, discoveryTimeoutMs, revalidateOwner);
    this.follows.set(id, { work, timeoutMs: discoveryTimeoutMs, revalidateOwner });
    try {
      return await work;
    } finally {
      if (this.follows.get(id)?.work === work) this.follows.delete(id);
    }
  }
  async followNow(id, discoveryTimeoutMs, freshSnapshot) {
    let owner;
    try {
      owner = await this.request(
        "thread-owner-discovery",
        { hostId: "local", conversationId: id },
        void 0,
        discoveryTimeoutMs
      );
    } catch (error) {
      this.owners.delete(id);
      this.liveWindows.delete(id);
      this.observedOwners.delete(id);
      this.retiredStreams.delete(id);
      this.terminalResets.delete(id);
      this.invalidate(id);
      if (error instanceof CodexRejection && error.message === "no-client-found") return void 0;
      if (error instanceof DesktopRequestTimeout) return void 0;
      throw error;
    }
    const ownerId = string(owner.handledByClientId);
    if (!ownerId || object(owner.result).supportsUntrustedAppInput !== true) {
      this.owners.delete(id);
      this.retiredStreams.delete(id);
      this.terminalResets.delete(id);
      this.invalidate(id);
      throw new CodexRejection("Desktop owner profile unsupported");
    }
    if (!freshSnapshot && this.owners.get(id) === ownerId && this.hasOwner(id))
      return this.state(id);
    if (this.owners.get(id) !== ownerId) {
      this.states.delete(id);
      this.retiredStreams.delete(id);
      this.terminalResets.delete(id);
      this.liveWindows.delete(id);
      this.observedOwners.delete(id);
    }
    this.owners.set(id, ownerId);
    let received = false;
    const skippedBefore = this.skippedFrames;
    this.snapshotReads.set(id, skippedBefore);
    try {
      await new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.get(id)?.delete(snapshotReceived);
          resolve();
        };
        const timer = setTimeout(done, 5e3);
        const waiting = this.waiters.get(id) ?? /* @__PURE__ */ new Set();
        const snapshotReceived = () => {
          received = true;
          waiting.delete(snapshotReceived);
          done();
        };
        waiting.add(snapshotReceived);
        this.waiters.set(id, waiting);
        try {
          this.following(id, true);
        } catch (error) {
          clearTimeout(timer);
          waiting.delete(snapshotReceived);
          reject(error);
        }
      });
    } finally {
      this.snapshotReads.delete(id);
    }
    if (!received) {
      this.invalidate(id);
      this.deferSnapshot(id, 3e4);
      if (this.skippedFrames !== skippedBefore) {
        this.limitedReads.delete(id);
        this.limitedReads.set(id, Date.now() + 3e4);
        while (this.limitedReads.size > 2048)
          this.limitedReads.delete(this.limitedReads.keys().next().value);
        return this.snapshotUnavailable();
      }
    }
    return this.state(id);
  }
  async snapshotUnavailable() {
    const { RuntimeError } = await import("./runtime-session.js");
    throw new RuntimeError(
      503,
      `\u6B64\u5BF9\u8BDD\u672A\u53D6\u5F97\u53EF\u7528\u684C\u9762\u5FEB\u7167\uFF0C\u671F\u95F4\u8DF3\u8FC7\u4E86\u8D85\u8FC7 ${desktopFrameLimits.materializedBytes / 1024 / 1024} MiB \u7684\u5E27\uFF1B\u8FD0\u884C\u72B6\u6001\u6682\u4E0D\u53EF\u8BFB\u53D6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5`
    );
  }
  async command(id, method, params, beforeExecutionWrite) {
    let state;
    try {
      state = await this.follow(id, 15e3, true);
    } catch (error) {
      throw new DesktopCommandNotSubmitted(
        error instanceof Error ? error.message : "Desktop owner discovery failed",
        true
      );
    }
    if (!state) throw new DesktopCommandNotSubmitted("\u8BF7\u5148\u5728 Codex \u4E2D\u6253\u5F00\u6B64\u5BF9\u8BDD\uFF0C\u518D\u5237\u65B0\u624B\u673A", true);
    const owner = this.owners.get(id);
    let result;
    try {
      result = await this.request(
        method,
        { ...params, conversationId: id },
        owner,
        15e3,
        beforeExecutionWrite
      );
    } catch (error) {
      if (error instanceof CodexRejection && ["no-client-found", "client-disconnected", "client-not-found"].includes(error.message)) {
        this.owners.delete(id);
        this.retiredStreams.delete(id);
        this.terminalResets.delete(id);
        this.invalidate(id);
      }
      throw error;
    }
    if (result.handledByClientId !== owner || result.method !== method)
      throw new Error("Desktop owner response mismatch; outcome uncertain");
    return object(result.result);
  }
  close() {
    this.socket?.destroy();
  }
};
export {
  DesktopCommandNotSubmitted,
  DesktopIpc,
  desktopTurns
};
