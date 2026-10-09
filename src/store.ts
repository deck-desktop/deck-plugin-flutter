// The running apps, outside React.
//
// Deck unmounts a module on navigation, so anything that must outlive a tab switch lives in a
// module-level store and components subscribe with useSyncExternalStore — the same rule Deck's
// own terminals follow. Here that is load-bearing twice over: the app keeps running while you
// are on another tab, and the log would otherwise be thrown away every time you looked away.
//
// This owns the whole lifecycle of a daemon-driven run: spawn, the event subscription, the VM
// Service socket, the log buffer, and the commands. The UI reads and calls; it holds nothing.
import { procStream, procWrite, procKill, configWrite, setDebugTargets } from "../shim/bridge.js";
import { listen } from "@tauri-apps/api/event";
import {
  parseLine, reloadCommand, restartCommand, stopCommand,
  LOGGING_SUBSCRIBE, EXTENSION_SUBSCRIBE,
  parseLogRecord, parseFlutterError, levelOf, type DaemonEvent,
} from "./daemon.js";
import { parseProfile, mergeCalls, toCall, type NetCall } from "./net.js";

/** One line in the log view. */
export interface LogLine {
  id: number;
  /** When Deck received it. Always set — the daemon's own output carries no timestamp. */
  ts: number;
  /**
   * When the APP logged it, from the VM Service record's `time`. Only set for a line off the
   * Logging stream, so the panel falls back to `ts` for everything else.
   *
   * Both are kept rather than one overwriting the other: they disagree when records queue behind
   * a flood, and which you want depends on whether you are reading the app's order or Deck's.
   */
  appTs?: number;
  text: string;
  /** Drives the colour. "raw" is flutter's own plain output. */
  kind: "raw" | "log" | "error" | "warn" | "info" | "fine" | "shout" | "progress" | "deck";
  /** The dart:developer logger name, when the line came from the Logging stream. */
  logger?: string;
}

export interface Run {
  /** The procStream id, and this run's handle everywhere. */
  id: string;
  cwd: string;
  deviceId: string;
  deviceName: string;
  /** Assigned by the daemon once the app starts; no command can be sent before it arrives. */
  appId: string;
  status: "starting" | "running" | "reloading" | "stopping" | "ended";
  log: LogLine[];
  /** Live VM Service socket, when the Logging stream is attached. */
  ws?: WebSocket;
  /** The VM Service's address, which the editor's debugger attaches to (publishTargets). */
  wsUri?: string;
  /** The app's HTTP calls, oldest first (see net.ts). Filled only while a Network view is open. */
  net: NetCall[];
}

/** Per run, what only the store needs for the network profile: never rendered. */
interface NetState {
  /** Isolates with HTTP logging switched on, each with the `updatedSince` for its next read. */
  since: Map<string, number>;
  /** Replies awaited on the VM Service socket, by request id. */
  pending: Map<string, (result: unknown) => void>;
  polling?: boolean;
}
const netState = new Map<string, NetState>();
/** How many calls to keep per run. A busy app makes thousands; the panel is for the recent ones. */
const MAX_NET = 1000;
let rpcSeq = 0;

/**
 * How many lines to keep per run. A chatty app produces thousands a minute and every one of
 * them is a React key; past a few thousand the view is the bottleneck, not the app.
 */
const MAX_LOG = 5000;

const runs = new Map<string, Run>();
const subs = new Set<() => void>();
let lineSeq = 0;
let cmdSeq = 1;

/** A snapshot for useSyncExternalStore. Rebuilt on change so identity comparison works. */
let snapshot: Run[] = [];
let publishTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Tell the panel something changed, at most ten times a second.
 *
 * Called per output line, and each call re-rendered the whole log (up to MAX_LOG rows): a chatty
 * process printing hundreds of lines a second kept the main thread busy for as long as it lasted.
 * A tenth of a second is still live to read, and a burst of any size costs ten renders a second.
 */
const publish = () => {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    snapshot = [...runs.values()];
    subs.forEach((f) => f());
    publishState();
    publishTargets();
  }, 100);
};

/**
 * Publish the runs to a config file, so the MCP tools can read what is going on.
 *
 * The webview is the only place these runs exist — Rust spawned the process but knows nothing
 * about apps or devices — so an agent asking "what is running" has nowhere else to look. This is
 * the same shape as term-procs.json, in the other direction.
 *
 * DEBOUNCED, and this is not an optimisation. Every config write lands in the directory Rust's
 * watcher observes, which emits `config-changed` with no payload saying which file moved, so each
 * one wakes every frontend listener in Deck. Writing per log line would run that cascade hundreds
 * of times a minute on a chatty app.
 *
 * The log is capped well below the in-memory buffer: this file exists to answer "did it reload,
 * did it crash", and the last couple of hundred lines carry that.
 */
const STATE_KEY = "plugin-flutter-runs";
const STATE_LOG_LINES = 200;
let stateTimer: ReturnType<typeof setTimeout> | undefined;

function publishState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const payload = {
      runs: [...runs.values()].map((r) => ({
        id: r.id, cwd: r.cwd, deviceId: r.deviceId, deviceName: r.deviceName,
        status: r.status, appId: r.appId,
        log: r.log.slice(-STATE_LOG_LINES).map((l) => ({
          ts: l.ts, kind: l.kind, logger: l.logger ?? "", text: l.text,
        })),
      })),
    };
    void configWrite(STATE_KEY, JSON.stringify(payload)).catch(() => {});
  }, 500);
}

/**
 * Offer each running app to the editor's debugger, which attaches to its VM Service (the Run and
 * Debug panel lists them as "Attach to <app> (<device>)"). The run stays the plugin's: the
 * debugger attaches beside it and detaches without stopping it.
 *
 * Republished only when the list changes, not on every publish: the panel re-renders on each.
 */
let lastTargets = "";
function publishTargets() {
  const targets = [...runs.values()]
    .filter((r) => r.wsUri && r.status !== "ended" && r.status !== "stopping")
    .map((r) => ({
      id: r.id,
      name: `${r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "app"} (${r.deviceName})`,
      languageId: "dart",
      request: "attach" as const,
      // Just your code: stepping skips the Dart SDK and packages (Flutter included), as VS Code's
      // Dart extension does by default. Otherwise F11 on a list literal steps into dart:core,
      // whose source has no file on disk, so there is no line to show.
      args: { vmServiceUri: r.wsUri, cwd: r.cwd, debugSdkLibraries: false, debugExternalPackageLibraries: false },
      cwd: r.cwd,
      // The Dart SDK's adapter, for a Dart language definition with no `debug` block of its own.
      adapter: { strategy: "exe-search", command: "dart", args: ["debug_adapter"] },
    }));
  const key = JSON.stringify(targets);
  if (key === lastTargets) return;
  lastTargets = key;
  try { setDebugTargets("flutter", targets); } catch { /* a Deck without the debugger */ }
}

// A fresh webview has no runs, and the file still holds the last session's. Clearing it at module
// scope stops an agent reporting an app that died with the previous window.
void configWrite(STATE_KEY, JSON.stringify({ runs: [] })).catch(() => {});

export const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); } };
export const getRuns = () => snapshot;
export const getRun = (id: string) => runs.get(id);

function append(run: Run, text: string, kind: LogLine["kind"], logger?: string, appTs?: number) {
  run.log.push({ id: ++lineSeq, ts: Date.now(), text, kind, logger, appTs });
  if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
}

/**
 * One subscription for every run, registered once.
 *
 * `proc-line` is a single event for every process Deck is streaming — the music plugin's
 * downloads included — so the id filter is what keeps runs apart. Registering per-run instead
 * would mean N listeners all rejecting N-1 of the same events.
 */
let wired: Promise<() => void> | null = null;
function wire() {
  if (wired) return wired;
  wired = listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    const run = runs.get(e.payload.id);
    if (!run) return;
    const evt = parseLine(e.payload);
    if (evt) handle(run, evt);
  });
  return wired;
}

function handle(run: Run, evt: DaemonEvent) {
  switch (evt.kind) {
    case "appId":
      run.appId = evt.appId;
      break;
    case "wsUri":
      run.wsUri = evt.uri;
      attachLogging(run, evt.uri);
      break;
    case "started":
      run.status = "running";
      append(run, "app started", "deck");
      break;
    case "stopped":
      run.status = "ended";
      break;
    case "progress":
      // Only the start of a step; the "finished" half would double every line.
      if (!evt.finished && evt.message) append(run, evt.message, "progress");
      break;
    case "log":
      append(run, evt.text, evt.error ? "error" : "log");
      break;
    case "devTools":
      append(run, `DevTools: ${evt.uri}`, "deck");
      break;
    case "raw":
      append(run, evt.text, "raw");
      break;
  }
  publish();
}

/**
 * Connect to the VM Service and subscribe to the Logging stream.
 *
 * This is the thing a plain `flutter run` cannot give you: `developer.log(...)` output goes to
 * this stream and nowhere else, so without this the app's own logging is invisible. The webview
 * opens the socket directly — Deck sets no CSP, and the VM Service listens on localhost.
 *
 * Failure is not fatal: a run whose socket will not open still shows print/debugPrint through
 * the daemon's app.log events, so it degrades to what a plain run would have given.
 */
function attachLogging(run: Run, uri: string) {
  try {
    const ws = new WebSocket(uri);
    run.ws = ws;
    const ns: NetState = { since: new Map(), pending: new Map() };
    netState.set(run.id, ns);
    ws.onopen = () => {
      ws.send(LOGGING_SUBSCRIBE);
      ws.send(EXTENSION_SUBSCRIBE);
      void startHttpLogging(run);
    };
    ws.onmessage = (m) => {
      const frame = typeof m.data === "string" ? m.data : "";
      if (netFrame(run, ns, frame)) return;

      // Framework errors (a RenderFlex overflow, a failed assertion) come down Stderr rather
      // than Logging, and arrive one event per write — so a multi-line error is a single frame.
      // A framework-reported error (an overflow, an assertion inside build). Comes as a
      // structured event rather than text, and is the ONLY way these are visible under
      // --machine — see the note on EXTENSION_SUBSCRIBE.
      const fe = parseFlutterError(frame);
      if (fe) {
        for (const l of fe.split("\n")) append(run, l.replace(/\s+$/, ""), "error");
        publish();
        return;
      }

      const rec = parseLogRecord(frame);
      if (!rec) return;
      const level = levelOf(rec);
      const at = rec.time || undefined;
      append(run, rec.message, level, rec.logger || undefined, at);
      // An error and its stack are separate lines under the message, not appended to it: a stack
      // is many lines already, and a filter matching the message should not drag 30 frames with
      // it. Same level, logger and time, so they stay attached to what they belong to.
      if (rec.error) append(run, rec.error, level, rec.logger || undefined, at);
      for (const frame of rec.stack.split("\n")) {
        if (frame.trim()) append(run, frame, level, rec.logger || undefined, at);
      }
      publish();
    };
    ws.onerror = () => {
      append(run, "could not attach the developer.log stream — print output still shows", "deck");
      publish();
    };
  } catch {
    append(run, "could not open the VM Service socket", "deck");
    publish();
  }
}

/**
 * Start an app and stream it.
 *
 * `flutter` rather than an absolute path: it is a .bat shim on Windows, which `Command::new`
 * cannot launch directly, so this goes through cmd.exe — which also gives PATH resolution.
 */
export async function start(cwd: string, deviceId: string, deviceName: string): Promise<string> {
  await wire();
  const id = `flutter-${Date.now().toString(36)}`;
  const run: Run = {
    id, cwd, deviceId, deviceName, appId: "", status: "starting", log: [], net: [],
  };
  runs.set(id, run);
  append(run, `flutter run -d ${deviceId}`, "deck");
  publish();

  // Not awaited: this resolves when the app EXITS, which is the whole session.
  const exit = procStream(id, "cmd", ["/C", "flutter", "run", "--machine", "-d", deviceId], cwd, true);
  exits.set(id, exit);
  follow(run, exit);
  return id;
}

type Exit = ReturnType<typeof procStream>;
/** Each live run's exit, kept so a reload can hand it to the next copy of the plugin. */
const exits = new Map<string, Exit>();
/** Set once this copy has handed its runs on: from then on the next copy reports their exit. */
let disposed = false;

function follow(run: Run, exit: Exit) {
  exit.then(
    (r) => {
      if (disposed) return;
      exits.delete(run.id);
      run.status = "ended";
      append(run, r.cancelled ? "stopped" : `exited with code ${r.code}`, "deck");
      publish();
    },
    (e) => {
      if (disposed) return;
      exits.delete(run.id);
      run.status = "ended";
      append(run, `could not start: ${String(e)}`, "error");
      publish();
    },
  );
}

/**
 * A VM Service call on the run's socket, resolving to its result (undefined on an error reply).
 *
 * The socket is shared with the log streams, so replies are told apart by id: ours are "n<seq>",
 * which the subscribe requests ("1", "2") never are.
 */
function rpc(run: Run, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const ns = netState.get(run.id);
  if (!ns || run.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
  const id = `n${++rpcSeq}`;
  return new Promise((resolve) => {
    ns.pending.set(id, resolve);
    run.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    // A reply that never comes (the app died mid-call) must not keep the promise, or the poll, waiting.
    setTimeout(() => { if (ns.pending.delete(id)) resolve(undefined); }, 10_000);
  });
}

/**
 * A frame that is ours: a reply to `rpc`, or an Isolate stream event. True when handled.
 *
 * Cheap tests first: most frames are log records, and parsing each a second time to find out it is
 * not a reply would double the work of a chatty app's log.
 */
function netFrame(run: Run, ns: NetState, frame: string): boolean {
  const reply = ns.pending.size > 0 && frame.includes('"id":"n');
  const isolate = frame.includes('"streamId":"Isolate"');
  if (!reply && !isolate) return false;
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(frame) as Record<string, unknown>; } catch { return false; }
  const id = typeof msg.id === "string" ? msg.id : "";
  const done = ns.pending.get(id);
  if (done) { ns.pending.delete(id); done(msg.result); return true; }
  const event = ((msg.params as Record<string, unknown> | undefined)?.event ?? {}) as Record<string, unknown>;
  const iso = String((event.isolate as Record<string, unknown> | undefined)?.id ?? "");
  // A new isolate (a hot restart makes one, as does Isolate.spawn) gets logging the moment dart:io
  // registers its extension; until then there is nothing to switch on.
  if (event.kind === "ServiceExtensionAdded" && event.extensionRPC === "ext.dart.io.httpEnableTimelineLogging" && iso) {
    void enableIn(run, iso);
  }
  if (event.kind === "IsolateExit" && iso) ns.since.delete(iso);
  return isolate;
}

/**
 * Switch on HTTP logging in every isolate now, and in every one that starts later.
 *
 * Retried for up to a minute until one isolate takes it. The socket can open before dart:io has
 * registered its extension, so the first try fails; and the "extension added" event that would
 * have caught it can arrive before the Isolate stream subscription is in place. Without the retry
 * a run sometimes recorded nothing at all.
 */
async function startHttpLogging(run: Run) {
  await rpc(run, "streamListen", { streamId: "Isolate" });
  for (let i = 0; i < 120; i++) {
    const ns = netState.get(run.id);
    if (!ns || run.ws?.readyState !== WebSocket.OPEN || ns.since.size) return;
    const vm = (await rpc(run, "getVM")) as { isolates?: { id: string }[] } | undefined;
    await Promise.all((vm?.isolates ?? []).map((iso) => enableIn(run, iso.id)));
    if (!ns.since.size) await new Promise((r) => setTimeout(r, 500));
  }
}

async function enableIn(run: Run, iso: string) {
  const r = (await rpc(run, "ext.dart.io.httpEnableTimelineLogging", { isolateId: iso, enabled: "true" })) as
    { enabled?: boolean } | undefined;
  const ns = netState.get(run.id);
  if (r?.enabled && ns && !ns.since.has(iso)) ns.since.set(iso, 0);
}

/** Read what changed in each isolate's profile since the last read, into `run.net`. */
async function pollNet(run: Run) {
  const ns = netState.get(run.id);
  // One read at a time: a slow app (paused at a breakpoint) would otherwise stack a read a second.
  if (!ns || ns.polling) return;
  ns.polling = true;
  try { await readProfiles(run, ns); } finally { ns.polling = false; }
}
async function readProfiles(run: Run, ns: NetState) {
  for (const [iso, since] of ns.since) {
    const r = await rpc(run, "ext.dart.io.getHttpProfile", since ? { isolateId: iso, updatedSince: since } : { isolateId: iso });
    if (!r) continue;
    const p = parseProfile(r);
    if (ns.since.has(iso)) ns.since.set(iso, p.since);
    const next = mergeCalls(run.net, p.calls, MAX_NET);
    if (next !== run.net) { run.net = next; publish(); }
  }
}

/**
 * Keep a run's network list current while a Network view shows it; the returned function stops.
 *
 * Polled only while someone is looking (rule 11), and that loses nothing: dart:io keeps every call
 * in the app until the profile is cleared, so the first read after opening the view catches up.
 * Hidden windows skip their ticks for the same reason.
 */
const netWatchers = new Map<string, { n: number; timer: ReturnType<typeof setInterval> }>();
export function watchNet(id: string): () => void {
  const w = netWatchers.get(id);
  if (w) w.n++;
  else {
    const tick = () => { const run = runs.get(id); if (run && !document.hidden) void pollNet(run); };
    tick();
    netWatchers.set(id, { n: 1, timer: setInterval(tick, 1000) });
  }
  return () => {
    const cur = netWatchers.get(id);
    if (cur && --cur.n <= 0) { clearInterval(cur.timer); netWatchers.delete(id); }
  };
}

/** One call in full: the request and response bodies, which the list does not carry. */
export async function netBodies(id: string, call: NetCall): Promise<{ call: NetCall; req?: number[]; res?: number[] } | null> {
  const run = runs.get(id);
  if (!run) return null;
  const r = (await rpc(run, "ext.dart.io.getHttpProfileRequest", { isolateId: call.isolateId, id: call.id })) as
    { requestBody?: number[]; responseBody?: number[] } | undefined;
  return r ? { call: toCall(r), req: r.requestBody, res: r.responseBody } : null;
}

/** Empty the list, and the app's own profile with it, so the calls stop taking its memory. */
export function clearNet(id: string) {
  const run = runs.get(id);
  if (!run) return;
  for (const iso of netState.get(id)?.since.keys() ?? []) void rpc(run, "ext.dart.io.clearHttpProfile", { isolateId: iso });
  run.net = [];
  publish();
}

/** Send a daemon command, if the app has reported its id yet. */
const send = (run: Run, frame: string) => procWrite(run.id, frame).catch(() => {});

export function reload(id: string) {
  const run = runs.get(id);
  if (!run?.appId) return;
  run.status = "reloading";
  publish();
  void send(run, reloadCommand(++cmdSeq, run.appId)).then(() => {
    if (run.status === "reloading") { run.status = "running"; publish(); }
  });
}

export function restart(id: string) {
  const run = runs.get(id);
  if (!run?.appId) return;
  run.status = "reloading";
  publish();
  void send(run, restartCommand(++cmdSeq, run.appId)).then(() => {
    if (run.status === "reloading") { run.status = "running"; publish(); }
  });
}

/**
 * Stop an app.
 *
 * Graceful first: `app.stop` lets the app shut down and frees the device, which matters most on
 * a phone where a killed app can leave the debugger attached. The kill is the fallback for a run
 * that never reported an appId, or one that ignores the request.
 */
export function stop(id: string) {
  const run = runs.get(id);
  if (!run) return;
  run.status = "stopping";
  publish();
  if (run.appId) {
    void send(run, stopCommand(++cmdSeq, run.appId));
    setTimeout(() => { if (runs.get(id)?.status === "stopping") void procKill(id).catch(() => {}); }, 4000);
  } else {
    void procKill(id).catch(() => {});
  }
}

/** Empty a run's log without touching the app. */
export function clearLog(id: string) {
  const run = runs.get(id);
  if (!run) return;
  run.log = [];
  publish();
}

/**
 * Commands arriving from the MCP tools, via Deck's HTTP API and a `plugin-command` event.
 *
 * The inbound half of the same split as publishState: an agent cannot reach into the webview, so
 * Rust forwards an opaque command and this decides what it means. Filtering on the plugin name is
 * required — the event is broadcast to every plugin.
 *
 * Fire-and-forget by design; the caller reads the published state afterwards to see what happened.
 */
const unCommand = listen<{ plugin: string; op: string; args: Record<string, unknown> }>("plugin-command", (e) => {
  const { plugin, op, args } = e.payload;
  if (plugin !== "flutter") return;
  const id = typeof args?.id === "string" ? args.id : "";
  switch (op) {
    case "start":
      void start(
        String(args?.cwd ?? ""),
        String(args?.deviceId ?? ""),
        String(args?.deviceName ?? args?.deviceId ?? ""),
      );
      break;
    // An empty id means "the one run", which is the normal case and saves the caller a lookup.
    case "reload":  reload(id || soleRun());  break;
    case "restart": restart(id || soleRun()); break;
    case "stop":    stop(id || soleRun());    break;
  }
});

/** Stop listening for MCP commands. The plugin's `dispose` calls this before Deck re-imports it,
 *  or one MCP command would start a run in every copy of the plugin a reload left behind. */
export function dispose() {
  disposed = true;
  void unCommand.then((un) => un()).catch(() => {});
  void wired?.then((un) => un()).catch(() => {});
  clearTimeout(publishTimer);
  clearTimeout(stateTimer);
  // The next copy of the plugin publishes its own runs; this copy's must not linger in the panel.
  try { setDebugTargets("flutter", []); } catch { /* a Deck without the debugger */ }
  for (const w of netWatchers.values()) clearInterval(w.timer);
  netWatchers.clear();
  // The apps keep running, so hand them to the next copy rather than forget them. Each socket's
  // handlers belong to this copy, so it is closed here and the next copy opens its own.
  for (const run of runs.values()) {
    if (run.ws) { run.ws.onmessage = run.ws.onerror = null; run.ws.close(); run.ws = undefined; }
  }
  handoff.value = { runs: [...runs.values()], exits: new Map(exits), lineSeq, cmdSeq };
}

/** The id of the only live run, or "" when there is none or the choice is ambiguous. */
function soleRun(): string {
  const live = [...runs.values()].filter((r) => r.status !== "ended");
  return live.length === 1 ? live[0].id : "";
}

/**
 * Runs passed from one copy of the plugin to the next across a reload (every rebuild in dev, an
 * update in a release). Without it the new copy started empty while `flutter run` and the app
 * kept going, with nothing left in Deck to show, reload or stop them.
 *
 * On the window because that is the one thing both copies share. A plugin switched off leaves its
 * runs here unclaimed, which orphans them as before.
 */
type Handoff = { runs: Run[]; exits: Map<string, Exit>; lineSeq: number; cmdSeq: number };
const handoff = {
  get value() { return (window as { __deckFlutterHandoff?: Handoff }).__deckFlutterHandoff; },
  set value(v) { (window as { __deckFlutterHandoff?: Handoff }).__deckFlutterHandoff = v; },
};
const handed = handoff.value;
if (handed) {
  handoff.value = undefined;
  // Line ids are React keys, so this copy carries on from where the last one stopped.
  lineSeq = handed.lineSeq;
  cmdSeq = handed.cmdSeq;
  void wire();
  for (const run of handed.runs) {
    runs.set(run.id, run);
    const exit = handed.exits.get(run.id);
    if (exit) { exits.set(run.id, exit); follow(run, exit); }
    if (run.wsUri && run.status !== "ended") attachLogging(run, run.wsUri);
  }
  publish();
}

/** Forget an ended run, closing its socket. */
export function dismiss(id: string) {
  const run = runs.get(id);
  run?.ws?.close();
  runs.delete(id);
  netState.delete(id);
  publish();
}
