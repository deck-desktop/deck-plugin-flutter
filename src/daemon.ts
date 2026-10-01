// The `flutter run --machine` daemon protocol.
//
// This is what the PowerShell wrapper did, moved into the plugin. `flutter run --machine` speaks
// newline-delimited JSON on stdout: each line is either a one-element array holding an event, or
// a response to a command we sent. We read events to learn the app id and the VM Service socket,
// and write commands to reload, restart and stop.
//
// WHY --machine RATHER THAN PLAIN `flutter run`. Plain run takes single keypresses on a terminal
// stdin, which works when a terminal owns the process. Driving it from a plugin means owning the
// pipe, and a pipe is not a console — so the keypress interface is not available. The daemon
// protocol is the supported way to do this, and it is also what the VS Code extension uses.
//
// Pure functions over strings: no Deck imports, so daemon.check can test the whole protocol
// without spawning anything.

/** Deck's `proc-line` payload, narrowed to what this module reads. */
export interface Line { stream: string; line: string }

/** What a daemon line told us. Everything a caller needs, with the JSON shape kept out of it. */
export type DaemonEvent =
  | { kind: "appId"; appId: string }
  /** The VM Service WebSocket. This is the one the flutter CLI never subscribes to. */
  | { kind: "wsUri"; uri: string }
  | { kind: "started" }
  | { kind: "stopped" }
  | { kind: "progress"; message: string; finished: boolean }
  /** print / debugPrint, forwarded by flutter itself. */
  | { kind: "log"; text: string; error: boolean }
  | { kind: "devTools"; uri: string }
  /** Anything not recognised, including plain non-JSON output like "Launching lib\main.dart". */
  | { kind: "raw"; text: string };

/**
 * Whether a line off stderr is part of a failure rather than ordinary chatter.
 *
 * Matched on shape, not on a running "are we inside an error" flag: lines arrive one event at a
 * time and a stack can be interleaved with other output, so a stateful reader would mis-colour
 * whatever landed in the middle. Each of these is unambiguous on its own.
 *
 *   [ERROR:flutter/runtime/...]        the engine's own error channel
 *   Unhandled Exception: / Exception:  the Dart VM's uncaught-error report
 *   EXCEPTION CAUGHT BY ...            the framework's error banner
 *   ══╡ ... ╞══                        the banner's box-drawing rule
 *   RenderFlex overflowed / overflow   a layout error
 *   #12  foo (bar.dart:3:4)            a stack frame, which only appears under one of the above
 *
 * A false positive costs a red line that should have been grey. A false negative costs a silent
 * failure, which is what this is here to stop — so the bias is deliberate.
 */
export function isErrorText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^\[ERROR[:\]]/i.test(t)
    || /^#\d+\s+\S/.test(t)
    || /Unhandled Exception/i.test(t)
    || /EXCEPTION CAUGHT BY/i.test(t)
    || /^[═╡╞=]{2,}/.test(t)
    || /overflowed/i.test(t)
    // "Error:" at the start, or after a source location — the shape of a Dart compiler
    // error, "lib/main.dart:12:3: Error: Expected ';'". Not a bare /Error:/ anywhere, which
    // would paint any line that merely quotes the word.
    || /^Error:/i.test(t)
    || /^\S+:\d+:\d+:\s*Error:/i.test(t)
    || /^Failed assertion/i.test(t);
}


/**
 * Turn one output line into an event.
 *
 * Non-JSON lines are `raw` rather than dropped: flutter prints a few ("Launching…", compiler
 * errors) and losing them would leave the log with gaps exactly when something went wrong.
 *
 * Returns null only for lines that are genuinely nothing to show — daemon handshakes and the
 * responses to our own commands, which would otherwise print raw JSON at the user.
 */
/** Drop the daemon's "flutter: " prefix from app output. */
export const stripPrefix = (text: string) => text.replace(/^flutter:\s?/, "");

export function parseLine({ stream, line }: Line): DaemonEvent | null {
  const text = line.trimEnd();
  if (!text) return null;
  // stderr is never the protocol; flutter's own diagnostics come through it.
  //
  // Classified rather than dumped as raw, because this is where an uncaught exception actually
  // arrives on desktop — engine lines like "[ERROR:flutter/runtime/...] Unhandled Exception:",
  // the Dart stack under it, and the framework's "EXCEPTION CAUGHT BY ..." banners. Left as raw
  // they printed in the same grey as "Launching lib\main.dart", which is the one moment the log
  // should not look ordinary.
  if (stream === "stderr") return { kind: "log", text, error: isErrorText(text) };
  // An engine error line ("[ERROR:flutter/runtime/...]") starts with "[" and is NOT JSON, so it
  // would fall through to the raw branch below and print in the same grey as "Launching...".
  // Checked BEFORE the JSON attempt, because that is what the text actually looks like.
  if (isErrorText(text)) return { kind: "log", text, error: true };
  if (!text.startsWith("[")) return { kind: "raw", text };

  let msg: unknown;
  try { msg = JSON.parse(text); } catch { return { kind: "raw", text }; }
  if (!Array.isArray(msg) || !msg.length) return { kind: "raw", text };

  const evt = msg[0] as Record<string, unknown>;
  // A response to something we sent (it carries our id, not an event name). Nothing to show.
  if (typeof evt.event !== "string") return null;
  const p = (evt.params ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  switch (evt.event) {
    case "app.start":     return { kind: "appId", appId: str(p.appId) };
    case "app.debugPort": return { kind: "wsUri", uri: str(p.wsUri) };
    case "app.started":   return { kind: "started" };
    case "app.stop":      return { kind: "stopped" };
    case "app.progress":  return { kind: "progress", message: str(p.message), finished: p.finished === true };
    // The "flutter: " prefix is the daemon's, not the app's — the same print arrives bare on
    // the VM Service stream. Stripped here so one line reads the same whichever path won the
    // race, and so the duplicate check compares like with like.
    case "app.log":       return { kind: "log", text: stripPrefix(str(p.log)), error: p.error === true };
    case "app.webLaunchUrl":
    case "app.devTools":  return { kind: "devTools", uri: str(p.uri) };
    // daemon.connected, app.dtd and anything future: noise, not worth showing as raw JSON.
    default:              return null;
  }
}

/**
 * A daemon command, ready to write to stdin.
 *
 * One JSON array per line is the framing the daemon expects; the trailing newline is part of the
 * message rather than something the caller adds, since `procWrite` appends nothing.
 *
 * `id` only has to be unique within a session — the daemon echoes it back on the response, and
 * nothing here waits for one.
 */
export const command = (id: number, method: string, params: Record<string, unknown>) =>
  `${JSON.stringify([{ id: String(id), method, params }])}\n`;

/** Hot reload (`r`) — keeps app state. */
export const reloadCommand = (id: number, appId: string) =>
  command(id, "app.restart", { appId, fullRestart: false });

/** Hot restart (`R`) — rebuilds the app, state is lost. */
export const restartCommand = (id: number, appId: string) =>
  command(id, "app.restart", { appId, fullRestart: true });

/** Graceful stop (`q`). Preferred over killing: it lets the app shut down and frees the device. */
export const stopCommand = (id: number, appId: string) =>
  command(id, "app.stop", { appId });

/**
 * Subscribe to the VM Service's Logging stream.
 *
 * THE WHOLE REASON THIS EXISTS: `developer.log(...)` — everything written through dart:developer,
 * including named loggers — goes to this stream and nowhere else. The flutter CLI never
 * subscribes, so those lines are invisible in a plain `flutter run`; only IDEs and DevTools see
 * them. Connecting here is what puts them in front of you.
 */
export const LOGGING_SUBSCRIBE =
  '{"jsonrpc":"2.0","id":"1","method":"streamListen","params":{"streamId":"Logging"}}';

/**
 * Subscribe to the VM Service's Extension stream.
 *
 * THIS IS THE ONE THAT CARRIES FRAMEWORK ERRORS. A RenderFlex overflow, a failed assertion inside
 * build — anything REPORTED rather than thrown — is not text on any stream. It is a structured
 * `Flutter.Error` event here.
 *
 * The chain, because it is not guessable:
 *   debug_overflow_indicator.dart calls FlutterError.reportError (reportError, not throw, which is
 *   why it never appears as "Unhandled Exception" on stdout)
 *     -> FlutterError.onError -> presentError
 *     -> widget_inspector.dart:1069 REBINDS presentError to _reportStructuredError whenever
 *        isStructuredErrorsEnabled(), which defaults TRUE in debug everywhere but web
 *     -> postEvent('Flutter.Error', ...) -> this stream.
 *
 * And the reason nothing printed it: resident_runner.dart:1216 reads
 * `if (event.extensionKind == 'Flutter.Error' && !machine)`. Under --machine the flutter tool
 * receives the event and deliberately declines to print it, assuming the IDE will render it.
 * We are the IDE.
 */
export const EXTENSION_SUBSCRIBE =
  '{"jsonrpc":"2.0","id":"2","method":"streamListen","params":{"streamId":"Extension"}}';

/**
 * Subscribe to the VM Service's Stderr stream.
 *
 * A SECOND stream, because framework errors do not go through Logging. A RenderFlex overflow, a
 * failed assertion, an exception caught by the framework — all of it is written by
 * FlutterError.onError, which lands on Stderr. Without this the app paints the yellow-and-black
 * stripes and the log stays silent, which is the one moment it should not.
 *
 */
/** One record off the Logging stream. */
export interface LogRecord {
  logger: string;
  message: string;
  level: number;
  /** `developer.log(error:)` — the object that was caught, already rendered to a string. */
  error: string;
  /** `developer.log(stackTrace:)`, newline-separated frames. */
  stack: string;
  /**
   * When the app logged it, in ms since the epoch — `developer.log(time:)`, defaulted by Dart to
   * the moment of the call.
   *
   * Worth carrying because it is not the same as when Deck read the line: a burst of records
   * arrives over one tick of the socket, and timestamping on receipt gives them all the same
   * clock and loses the order's spacing. 0 when the field is absent.
   */
  time: number;
}

/**
 * Pull a log record out of a VM Service frame, or null if the frame is anything else.
 *
 * The values arrive as `{ valueAsString }` wrappers because the VM Service returns Dart objects
 * by reference; for strings the preview is the whole value, which is why this reads that field
 * rather than following a reference.
 */
export function parseLogRecord(frame: string): LogRecord | null {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(frame) as Record<string, unknown>; } catch { return null; }
  if (msg.method !== "streamNotify") return null;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const event = (params.event ?? {}) as Record<string, unknown>;
  const rec = event.logRecord as Record<string, unknown> | undefined;
  if (!rec) return null;
  const s = (v: unknown) => {
    const o = v as { valueAsString?: unknown } | undefined;
    return typeof o?.valueAsString === "string" ? o.valueAsString : "";
  };
  /**
   * The same, for a field that is ABSENT rather than empty when unused.
   *
   * A record logged without an error or a stack still carries both, as a Dart null — which the
   * VM Service reports as kind "Null" with valueAsString "null". Read literally that printed a
   * four-character `null` under every developer.log line that had neither.
   *
   * Only for error/stackTrace. `message` gets the plain reader above, because
   * `developer.log('null')` is a real message and must survive.
   */
  const opt = (v: unknown) => {
    const o = v as { valueAsString?: unknown; kind?: unknown } | undefined;
    if (!o || o.kind === "Null") return "";
    const t = typeof o.valueAsString === "string" ? o.valueAsString : "";
    return t === "null" ? "" : t;
  };
  return {
    logger: s(rec.loggerName),
    message: s(rec.message),
    level: typeof rec.level === "number" ? rec.level : 0,
    // Both are optional and usually absent. A record that carries them is the interesting case —
    // `developer.log('…', error: e, stackTrace: st)` — and dropping them left the message on its
    // own, which reads as though nothing was caught.
    //
    // The VM Service sends a "@Instance" for a non-string error, whose valueAsString is the
    // preview rather than the whole object. That is what toString() would have given anyway,
    // which is what a log line wants.
    error: opt(rec.error),
    stack: opt(rec.stackTrace),
    // A plain int, not an @Instance wrapper like the others.
    time: typeof rec.time === "number" ? rec.time : 0,
  };
}

/**
 * The severity band a record belongs to, from dart:developer's levels.
 *
 * 1000 SHOUT, 900 SEVERE, 800 WARNING; below that is INFO and finer. A named logger with no
 * level set (the common case for an app's own `[AppLog]` traffic) reads as "info" rather than
 * disappearing into the same grey as framework chatter.
 */
export function levelOf(r: LogRecord): "shout" | "error" | "warn" | "info" | "fine" {
  if (r.level >= 1000) return "shout";
  if (r.level >= 900) return "error";
  if (r.level >= 800) return "warn";
  return r.logger && r.logger !== "log" ? "info" : "fine";
}

/** A Dart stack frame, split so the log view can lay the location out separately. */
export interface StackFrame {
  /** "#0", for the gutter. */
  num: string;
  /** The function, e.g. "_MyHomePageState._logWithError". */
  what: string;
  /** The uri as Dart wrote it: "package:foo/main.dart" or "file:///…" or "dart:ui". */
  uri: string;
  line: number;
  column: number;
  /** "main.dart:144" — what the location reads as on screen. */
  short: string;
}

/**
 * Parse one line of a Dart stack trace, or null if it is not one.
 *
 * The shape is `#<n><spaces><function> (<uri>:<line>:<col>)`, and the column is sometimes absent.
 * Worth parsing rather than printing raw because the uri is the longest part of the line and the
 * least often read — pulling it out lets the view put the function first and the location where
 * it can be clicked, which is what an IDE does with the same text.
 *
 * `package:` and `dart:` uris are deliberately kept as written. Only the view knows whether it
 * can resolve one to a file on disk, and a frame that cannot be resolved is still worth reading.
 */
export function parseStackFrame(text: string): StackFrame | null {
  const m = /^(#\d+)\s+(.+?)\s+\((\S+?):(\d+)(?::(\d+))?\)\s*$/.exec(text);
  if (!m) return null;
  const [, num, what, uri, line, column] = m;
  // The file name alone: a stack is read by scanning for the frame in YOUR code, and
  // "package:flutter/src/gestures/tap.dart" is mostly prefix that pushes that name off screen.
  const file = uri.split("/").pop() || uri;
  return {
    num,
    what,
    uri,
    line: Number(line),
    column: Number(column ?? 0),
    short: `${file}:${line}`,
  };
}

/**
 * Where a stack frame's uri lives on disk, or "" if it is not this project's own code.
 *
 * Only `package:<name>/…` is resolved, and only against the running project: by Dart's layout
 * that is `<cwd>/lib/…`, which is a rule rather than a guess. A `file:///` uri is already a path
 * and is handed back as one.
 *
 * Everything else — `dart:ui`, and any package from the pub cache — returns "". Those live in
 * the SDK or under a versioned cache directory that this cannot know, and offering a link that
 * opens nothing is worse than offering none: the frame is still perfectly readable as text.
 */
export function frameFile(uri: string, cwd: string, packageName: string): string {
  if (uri.startsWith("file:///")) {
    // "file:///D:/x/main.dart" -> "D:/x/main.dart"; a POSIX path keeps its leading slash.
    const p = decodeURIComponent(uri.slice("file://".length));
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
  }
  const pkg = /^package:([^/]+)\/(.+)$/.exec(uri);
  if (!pkg || !cwd || !packageName) return "";
  const [, name, rest] = pkg;
  if (name !== packageName) return "";
  return `${cwd.replace(/[\/]+$/, "")}/lib/${rest}`;
}

/**
 * The text of a `Flutter.Error` extension event, or "" for any other frame.
 *
 * `renderedErrorText` is produced by the framework with the SAME TextTreeRenderer the console
 * uses (widget_inspector.dart:1020), and `flutter run` without --machine prints exactly this
 * string — so taking it verbatim gives output identical to a plain terminal run.
 *
 * On the second and later errors since a reload it is shortened to "Another exception was thrown:
 * <summary>", which is the framework's own behaviour and worth keeping rather than papering over:
 * a hot reload resets the counter and the full text returns. Walking the properties/children tree
 * to rebuild full text ourselves would be reimplementing the renderer for that one case.
 */
export function parseFlutterError(frame: string): string {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(frame) as Record<string, unknown>; } catch { return ""; }
  if (msg.method !== "streamNotify") return "";
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const event = (params.event ?? {}) as Record<string, unknown>;
  if (event.extensionKind !== "Flutter.Error") return "";
  const data = (event.extensionData ?? {}) as Record<string, unknown>;
  const rendered = typeof data.renderedErrorText === "string" ? data.renderedErrorText : "";
  if (rendered.trim()) return rendered;
  // No rendered text (an older framework, or a truncated payload): the node's own description is
  // still better than silence.
  const desc = typeof data.description === "string" ? data.description : "";
  return desc.trim();
}
