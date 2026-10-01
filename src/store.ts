// The running apps, outside React.
//
// Deck unmounts a module on navigation, so anything that must outlive a tab switch lives in a
// module-level store and components subscribe with useSyncExternalStore — the same rule Deck's
// own terminals follow. Here that is load-bearing twice over: the app keeps running while you
// are on another tab, and the log would otherwise be thrown away every time you looked away.
//
// This owns the whole lifecycle of a daemon-driven run: spawn, the event subscription, the VM
// Service socket, the log buffer, and the commands. The UI reads and calls; it holds nothing.
import { procStream, procWrite, procKill, configWrite } from "../shim/bridge.js";
import { listen } from "@tauri-apps/api/event";
import {
  parseLine, reloadCommand, restartCommand, stopCommand,
  LOGGING_SUBSCRIBE, EXTENSION_SUBSCRIBE,
  parseLogRecord, parseFlutterError, levelOf, type DaemonEvent,
} from "./daemon.js";

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
}

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
const publish = () => {
  snapshot = [...runs.values()];
  subs.forEach((f) => f());
  publishState();
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
let wired: Promise<void> | null = null;
function wire() {
  if (wired) return wired;
  wired = listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    const run = runs.get(e.payload.id);
    if (!run) return;
    const evt = parseLine(e.payload);
    if (evt) handle(run, evt);
  }).then(() => {});
  return wired;
}

function handle(run: Run, evt: DaemonEvent) {
  switch (evt.kind) {
    case "appId":
      run.appId = evt.appId;
      break;
    case "wsUri":
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
    ws.onopen = () => {
      ws.send(LOGGING_SUBSCRIBE);
      ws.send(EXTENSION_SUBSCRIBE);
    };
    ws.onmessage = (m) => {
      const frame = typeof m.data === "string" ? m.data : "";

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
    id, cwd, deviceId, deviceName, appId: "", status: "starting", log: [],
  };
  runs.set(id, run);
  append(run, `flutter run -d ${deviceId}`, "deck");
  publish();

  // Not awaited: this resolves when the app EXITS, which is the whole session.
  void procStream(id, "cmd", ["/C", "flutter", "run", "--machine", "-d", deviceId], cwd, true)
    .then((r) => {
      run.status = "ended";
      append(run, r.cancelled ? "stopped" : `exited with code ${r.code}`, "deck");
      publish();
    })
    .catch((e) => {
      run.status = "ended";
      append(run, `could not start: ${String(e)}`, "error");
      publish();
    });
  return id;
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
void listen<{ plugin: string; op: string; args: Record<string, unknown> }>("plugin-command", (e) => {
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

/** The id of the only live run, or "" when there is none or the choice is ambiguous. */
function soleRun(): string {
  const live = [...runs.values()].filter((r) => r.status !== "ended");
  return live.length === 1 ? live[0].id : "";
}

/** Forget an ended run, closing its socket. */
export function dismiss(id: string) {
  const run = runs.get(id);
  run?.ws?.close();
  runs.delete(id);
  publish();
}
