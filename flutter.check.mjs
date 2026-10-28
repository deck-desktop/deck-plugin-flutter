// node flutter.check.mjs
//
// The detection logic that Deck's Rust sweep used to hold. Worth checking because each function
// has one way of being subtly wrong that a running app would not obviously show:
//
//   isFlutterRun   — dart.exe is also the language server and the DDS; matching too loosely puts
//                    hot-reload buttons on a pane that is not running an app.
//   runForFile     — with two apps open, the wrong answer reloads someone else's project.
//   parseDevices   — the command prints warnings above its JSON, so parsing all of stdout fails
//                    on machines where the devices are fine.
//
// Pure string logic, so no Deck and no Flutter SDK needed.
import assert from "node:assert";
import { build } from "esbuild";

const out = await build({
  entryPoints: ["src/detect.ts"],
  bundle: true, format: "esm", write: false, platform: "node",
});
const d = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

// ---- isFlutterRun --------------------------------------------------------------------------
const SNAP = "C:\\src\\flutter\\bin\\cache\\flutter_tools.snapshot";

assert.ok(d.isFlutterRun({ name: "dart.exe", cmd: `dart ${SNAP} run -d windows` }),
  "a real flutter run must be recognised");
assert.ok(d.isFlutterRun({ name: "DART.EXE", cmd: `DART ${SNAP.toUpperCase()} RUN` }),
  "matching is case-insensitive: the sweep lowercases names but not always the command");

// The three dart.exe processes that are NOT an app.
assert.ok(!d.isFlutterRun({ name: "dart.exe", cmd: "dart language-server --protocol=lsp" }),
  "the editor's language server is dart.exe too");
assert.ok(!d.isFlutterRun({ name: "dart.exe", cmd: `dart ${SNAP} pub get` }),
  "pub get is the flutter tool but not a running app");
assert.ok(!d.isFlutterRun({ name: "dart.exe", cmd: `dart ${SNAP} build apk` }),
  "build is the flutter tool but not a running app");

// Not dart at all.
assert.ok(!d.isFlutterRun({ name: "node.exe", cmd: `node ${SNAP} run` }),
  "only dart.exe counts, whatever the command line says");

// The reason `run` is matched as a whole word rather than with includes().
assert.ok(!d.isFlutterRun({ name: "dart.exe", cmd: `dart ${SNAP} pub get --directory C:\\runners\\app` }),
  "a path containing 'run' must not look like the run subcommand");

// ---- runningPanes --------------------------------------------------------------------------
assert.deepEqual(
  d.runningPanes({
    p1: [{ name: "dart.exe", cmd: `dart ${SNAP} run` }],
    p2: [{ name: "dart.exe", cmd: "dart language-server" }],
    p3: [{ name: "node.exe", cmd: "node server.js" }, { name: "dart.exe", cmd: `dart ${SNAP} run` }],
  }),
  ["p1", "p3"],
  "a pane counts if ANY of its processes is a flutter run",
);
assert.deepEqual(d.runningPanes({}), [], "no panes is not an error");

// ---- runForFile ----------------------------------------------------------------------------
const runs = [
  { paneId: "outer", cwd: "D:/work/monorepo", wsId: "w", label: "outer" },
  { paneId: "inner", cwd: "D:/work/monorepo/packages/app", wsId: "w", label: "inner" },
  { paneId: "other", cwd: "D:/work/unrelated", wsId: "w", label: "other" },
];

assert.equal(d.runForFile(runs, "D:/work/monorepo/packages/app/lib/main.dart")?.paneId, "inner",
  "the nested package must win over the parent repo, or a save reloads the wrong app");
assert.equal(d.runForFile(runs, "D:/work/monorepo/tool/gen.dart")?.paneId, "outer",
  "a file outside the nested package still belongs to the repo's run");
assert.equal(d.runForFile(runs, "D:/elsewhere/main.dart"), null,
  "a file under no run reloads nothing");

// Windows gives both spellings depending on who produced the path.
assert.equal(d.runForFile(runs, "D:\\work\\monorepo\\packages\\app\\lib\\main.dart")?.paneId, "inner",
  "backslash paths must match the same run as forward-slash ones");
assert.equal(d.runForFile(runs, "d:/WORK/MonoRepo/packages/app/lib/Main.dart")?.paneId, "inner",
  "Windows paths are case-insensitive");

// A cwd that is a string prefix but not a path prefix.
assert.equal(d.runForFile([{ paneId: "a", cwd: "D:/work/app", wsId: "w", label: "a" }],
  "D:/work/app-tools/lib/main.dart"), null,
  "'app-tools' must not match the run in 'app' — prefix matching is per path segment");

// ---- parseDevices --------------------------------------------------------------------------
const DEVICES = JSON.stringify([
  { id: "windows", name: "Windows", platformType: "windows", emulator: false },
  { id: "emulator-5554", name: "sdk gphone64", platformType: "android", emulator: true },
]);

let parsed = d.parseDevices(DEVICES);
assert.equal(parsed.length, 2);
assert.deepEqual(parsed[0], { id: "windows", name: "Windows", platform: "windows", emulator: false });
assert.equal(parsed[1].emulator, true);

// The case that motivated slicing from the first "[".
parsed = d.parseDevices(`Warning: the flutter tool is out of date.\n${DEVICES}`);
assert.equal(parsed.length, 2, "a warning printed above the JSON must not lose the devices");

assert.deepEqual(d.parseDevices("[]"), [], "no devices is a valid answer");
assert.deepEqual(d.parseDevices(""), [], "empty output must not throw");
assert.deepEqual(d.parseDevices("Error: no SDK found"), [], "non-JSON output must not throw");
assert.deepEqual(d.parseDevices("[{not json"), [], "truncated JSON must not throw");

// A row with no id cannot be launched, so it is dropped rather than shown as a blank entry.
assert.deepEqual(d.parseDevices('[{"name":"mystery"}]'), []);

// targetPlatform is the fallback when platformType is absent.
assert.equal(d.parseDevices('[{"id":"x","name":"X","targetPlatform":"android-arm64"}]')[0].platform,
  "android-arm64");

// The real shape, copied from `flutter devices --machine` on a Windows machine. Worth pinning:
// the actual output carries NO platformType at all, so the targetPlatform fallback above is not
// an edge case — it is the only path that ever runs, and losing it would blank every icon.
const REAL = `[
  { "name": "Windows", "id": "windows", "isSupported": true, "targetPlatform": "windows-x64",
    "emulator": false, "sdk": "Microsoft Windows" },
  { "name": "Chrome", "id": "chrome", "isSupported": true, "targetPlatform": "web-javascript",
    "emulator": false, "sdk": "Google Chrome 152.0.7977.84" }
]`;
const real = d.parseDevices(REAL);
assert.deepEqual(real.map((x) => x.id), ["windows", "chrome"]);
assert.deepEqual(real.map((x) => x.platform), ["windows-x64", "web-javascript"]);
// The plugin keys its icon off the family before the dash.
assert.deepEqual(real.map((x) => x.platform.split("-")[0]), ["windows", "web"]);

// ---- the daemon protocol ---------------------------------------------------------------------
// This is the half that replaced the PowerShell wrapper. Worth checking closely: a wrong field
// name here is not a crash, it is an app that launches and then silently never reloads.
const dout = await build({
  entryPoints: ["src/daemon.ts"],
  bundle: true, format: "esm", write: false, platform: "node",
});
const p = await import(
  `data:text/javascript;base64,${Buffer.from(dout.outputFiles[0].text).toString("base64")}`
);

const ev = (line, stream = "stdout") => p.parseLine({ stream, line });

// The two events the whole thing hinges on: without appId no command can be addressed, and
// without wsUri there is no developer.log stream.
assert.deepEqual(ev('[{"event":"app.start","params":{"appId":"abc123","deviceId":"windows"}}]'),
  { kind: "appId", appId: "abc123" });
assert.deepEqual(ev('[{"event":"app.debugPort","params":{"wsUri":"ws://127.0.0.1:5555/ws"}}]'),
  { kind: "wsUri", uri: "ws://127.0.0.1:5555/ws" });

assert.deepEqual(ev('[{"event":"app.started","params":{}}]'), { kind: "started" });
assert.deepEqual(ev('[{"event":"app.log","params":{"log":"hello","error":false}}]'),
  { kind: "log", text: "hello", error: false });
assert.equal(ev('[{"event":"app.log","params":{"log":"boom","error":true}}]').error, true);
assert.deepEqual(ev('[{"event":"app.progress","params":{"message":"Building…","finished":false}}]'),
  { kind: "progress", message: "Building…", finished: false });

// Responses to our own commands carry an id and no event name. They are a reply, never a log
// line (which would print raw JSON at the user on every hot reload), and a reload's reply is how
// its end is known: the notification comes down on it.
assert.deepEqual(ev('[{"id":"2","result":{"code":0,"message":"Reloaded 3 of 512 libraries in 210ms."}}]'),
  { kind: "reply", id: "2", ok: true, message: "Reloaded 3 of 512 libraries in 210ms." });
assert.deepEqual(ev('[{"id":"3","result":{"code":1,"message":"Reload rejected: a const changed."}}]'),
  { kind: "reply", id: "3", ok: false, message: "Reload rejected: a const changed." }, "a non-zero code is a failure");
assert.deepEqual(ev('[{"id":"4","error":"app not found"}]'),
  { kind: "reply", id: "4", ok: false, message: "app not found" }, "an error answer is a failure");
assert.equal(ev('[{"id":5,"result":{}}]').id, "5", "the id is matched as a string, as it was sent");
assert.equal(ev('[{"event":"daemon.connected","params":{"version":"0.6.1"}}]'), null,
  "daemon handshake is noise");

// Non-JSON output must survive: flutter prints these, and compiler errors arrive this way.
assert.deepEqual(ev("Launching lib\\main.dart on Windows in debug mode..."),
  { kind: "raw", text: "Launching lib\\main.dart on Windows in debug mode..." });
assert.deepEqual(ev("lib/main.dart:12:3: Error: Expected ';'", "stderr"),
  { kind: "log", text: "lib/main.dart:12:3: Error: Expected ';'", error: true });
assert.equal(ev(""), null, "blank lines are not events");
assert.deepEqual(ev("[truncated json"), { kind: "raw", text: "[truncated json" },
  "a malformed line must not throw");

// ---- commands ----------------------------------------------------------------------------------
const reload = p.reloadCommand(2, "abc123");
assert.ok(reload.endsWith("\n"), "the daemon frames on newlines, so one must terminate the message");
const sent = JSON.parse(reload)[0];
assert.equal(sent.method, "app.restart");
assert.equal(sent.params.appId, "abc123");
assert.equal(sent.params.fullRestart, false, "hot reload keeps state; fullRestart would lose it");
assert.equal(JSON.parse(p.restartCommand(3, "x"))[0].params.fullRestart, true);
assert.equal(JSON.parse(p.stopCommand(4, "x"))[0].method, "app.stop");
assert.equal(JSON.parse(reload)[0].id, "2", "the id is a string — the daemon echoes it back");

// ---- how a run's end is reported ---------------------------------------------------------------
// A stop the user asked for says nothing, whatever the code: a killed process exits non-zero, and a
// card calling that a crash would fire on every Stop.
assert.equal(p.exitNotice(true, 0, true), null);
assert.equal(p.exitNotice(true, 1, true), null, "a stop that ended in a kill is still the user's stop");
assert.deepEqual(p.exitNotice(false, 0, true), { kind: "activity", verb: "exited" },
  "a clean exit nobody asked for is news, not a failure");
assert.deepEqual(p.exitNotice(false, 1, true), { kind: "error", verb: "crashed" });
assert.deepEqual(p.exitNotice(false, 1, false), { kind: "error", verb: "could not start" },
  "an app that never reached the device (a build error) did not crash");

// ---- the Logging stream ------------------------------------------------------------------------
const record = (logger, message, level) => JSON.stringify({
  method: "streamNotify",
  params: { streamId: "Logging", event: {
    logRecord: { loggerName: { valueAsString: logger }, message: { valueAsString: message }, level },
  } },
});

assert.deepEqual(p.parseLogRecord(record("AppLog", "user tapped save", 0)),
  { logger: "AppLog", message: "user tapped save", level: 0, error: "", stack: "", time: 0 },
  "the fields a record does not carry come back empty, never undefined");

// A record that DOES carry an error and a stack. This is the case that was silently dropped:
// `developer.log('…', error: e, stackTrace: st)` showed its message and nothing else.
const withError = JSON.stringify({
  method: "streamNotify",
  params: { streamId: "Logging", event: { logRecord: {
    loggerName: { valueAsString: "AppLog" },
    message: { valueAsString: "caught and logged" },
    level: 1000,
    error: { valueAsString: "Bad state: a handled failure" },
    stackTrace: { valueAsString: "#0  _a (file:///x.dart:1)\n#1  _b (file:///x.dart:2)" },
    time: 1758042293000,
  } } },
});
const we = p.parseLogRecord(withError);
assert.equal(we.error, "Bad state: a handled failure");
assert.equal(we.stack.split("\n").length, 2, "the stack keeps its frames");
assert.equal(we.time, 1758042293000, "the app's own clock, not Deck's");


assert.equal(p.parseLogRecord('{"method":"streamNotify","params":{"event":{}}}'), null,
  "a non-log frame on the same stream is not a record");
assert.equal(p.parseLogRecord("not json"), null, "a malformed frame must not throw");

// Severity bands, which drive the colour in the log view.
const lvl = (logger, level) => p.levelOf({ logger, message: "", level, error: "", stack: "", time: 0 });
assert.equal(lvl("x", 1000), "shout");
assert.equal(lvl("x", 900), "error");
assert.equal(lvl("x", 800), "warn");
// The distinction that matters day to day: a named logger with no level is the app's own
// output and should not sink into the same grey as framework chatter.
assert.equal(lvl("AppLog", 0), "info");
assert.equal(lvl("log", 0), "fine", "bare developer.log() has loggerName 'log'");
assert.equal(lvl("", 0), "fine");

// ---- classifying stderr -----------------------------------------------------------------------
// What actually arrives when an app throws on Windows desktop, copied from a real run. These used
// to be `raw`, which painted an uncaught exception the same grey as "Launching lib\main.dart".
assert.ok(p.isErrorText("[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Exception: async boom"));
assert.ok(p.isErrorText("#0      _MyHomePageState._throwAsync.<anonymous closure> (package:x/main.dart:170:7)"));
assert.ok(p.isErrorText("A RenderFlex overflowed by 179 pixels on the right."));
assert.ok(p.isErrorText("══╡EXCEPTION CAUGHT BY RENDERING LIBRARY╞══"));
assert.ok(p.isErrorText("Failed assertion: line 12 pos 5: 'x != null'"));
assert.ok(p.isErrorText("Error: something went wrong"));

// Ordinary chatter on the same pipe must stay grey.
assert.ok(!p.isErrorText("Launching lib\main.dart on Windows in debug mode..."));
assert.ok(!p.isErrorText("Syncing files to device Windows..."));
assert.ok(!p.isErrorText(""));
assert.ok(!p.isErrorText("   "));
// "#" alone is not a frame — a frame is #<digits><space><something>.
assert.ok(!p.isErrorText("#hashtag"));

// parseLine routes stderr through it, so the colour follows from the content.
const se = (t) => p.parseLine({ stream: "stderr", line: t });
assert.deepEqual(se("[ERROR:flutter/x.cc(1)] Unhandled Exception: boom"),
  { kind: "log", text: "[ERROR:flutter/x.cc(1)] Unhandled Exception: boom", error: true });
assert.deepEqual(se("Launching lib\main.dart on Windows in debug mode..."),
  { kind: "log", text: "Launching lib\main.dart on Windows in debug mode...", error: false });

// The lines that actually arrive when an app throws come down STDOUT, not stderr — an engine
// error starts with "[", is not JSON, and used to fall through to `raw` and print grey.
// This is the case the first attempt at this fix missed by assuming the pipe.
const so = (t) => p.parseLine({ stream: "stdout", line: t });
assert.deepEqual(
  so("[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Exception: boom"),
  { kind: "log", error: true,
    text: "[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Exception: boom" },
  "an engine error on stdout is an error, not raw");
assert.equal(so("#0      _MyHomePageState._throwAsync.<anonymous closure>").error, true,
  "the stack under it is part of the same failure");
assert.equal(so("A RenderFlex overflowed by 106 pixels on the right.").error, true);
// Ordinary progress output on the same pipe stays plain.
assert.deepEqual(so("Syncing files to device Windows..."),
  { kind: "raw", text: "Syncing files to device Windows..." });
// And the daemon's own JSON is still parsed as protocol rather than caught by the classifier.
assert.deepEqual(so('[{"event":"app.started","params":{}}]'), { kind: "started" });

// ---- Flutter.Error, the structured framework errors ---------------------------------------------
// The case that defeated three earlier attempts. A RenderFlex overflow is reported, NOT thrown, so
// it never reaches stdout as an exception; widget_inspector rebinds FlutterError.presentError to
// post a structured `Flutter.Error` event instead, and resident_runner.dart:1216 explicitly does
// not print it under --machine ("&& !machine"). The Extension stream is the only way to see it.
assert.match(p.parseFlutterError("{\"method\": \"streamNotify\", \"params\": {\"streamId\": \"Extension\", \"event\": {\"kind\": \"Extension\", \"extensionKind\": \"Flutter.Error\", \"extensionData\": {\"errorsSinceReload\": 0, \"renderedErrorText\": \"\\u2550\\u2550\\u2561EXCEPTION CAUGHT BY RENDERING LIBRARY\\u255e\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\nThe following assertion was thrown during layout:\\nA RenderFlex overflowed by 179 pixels on the right.\\n\", \"description\": \"A RenderFlex overflowed by 179 pixels on the right.\"}}}}"), /RenderFlex overflowed by 179 pixels/);
assert.match(p.parseFlutterError("{\"method\": \"streamNotify\", \"params\": {\"streamId\": \"Extension\", \"event\": {\"kind\": \"Extension\", \"extensionKind\": \"Flutter.Error\", \"extensionData\": {\"errorsSinceReload\": 0, \"renderedErrorText\": \"\\u2550\\u2550\\u2561EXCEPTION CAUGHT BY RENDERING LIBRARY\\u255e\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\u2550\\nThe following assertion was thrown during layout:\\nA RenderFlex overflowed by 179 pixels on the right.\\n\", \"description\": \"A RenderFlex overflowed by 179 pixels on the right.\"}}}}"), /EXCEPTION CAUGHT BY RENDERING LIBRARY/,
  "renderedErrorText is taken verbatim — the framework already rendered it with the console's own renderer");

// From the second error since a reload the framework itself shortens the text. Kept as-is rather
// than rebuilt from the tree: a hot reload resets the counter and the full text returns.
assert.match(p.parseFlutterError("{\"method\": \"streamNotify\", \"params\": {\"streamId\": \"Extension\", \"event\": {\"kind\": \"Extension\", \"extensionKind\": \"Flutter.Error\", \"extensionData\": {\"errorsSinceReload\": 3, \"renderedErrorText\": \"Another exception was thrown: A RenderFlex overflowed by 179 pixels on the right.\"}}}}"), /^Another exception was thrown:/);

// No renderedErrorText (older framework, truncated payload): the description still beats silence.
assert.equal(p.parseFlutterError("{\"method\": \"streamNotify\", \"params\": {\"streamId\": \"Extension\", \"event\": {\"kind\": \"Extension\", \"extensionKind\": \"Flutter.Error\", \"extensionData\": {\"description\": \"A RenderFlex overflowed by 8.0 pixels on the bottom.\"}}}}"),
  "A RenderFlex overflowed by 8.0 pixels on the bottom.");

// Other extension events on the same stream are not ours.
assert.equal(p.parseFlutterError("{\"method\": \"streamNotify\", \"params\": {\"streamId\": \"Extension\", \"event\": {\"kind\": \"Extension\", \"extensionKind\": \"Flutter.ServiceExtensionStateChanged\", \"extensionData\": {\"extension\": \"ext.flutter.debugPaint\", \"value\": \"true\"}}}}"), "", "ServiceExtensionStateChanged is not an error");
assert.equal(p.parseFlutterError(record("AppLog", "hello", 0)), "", "a Logging record is not one either");
assert.equal(p.parseFlutterError("not json"), "", "a malformed frame must not throw");

// TWO streams, and only two. Stdout and Stderr were tried and removed: the daemon already
// forwards print and stderr as app.log/raw, so subscribing to them delivered every line twice and
// bought nothing — the overflow that prompted them turned out to be on Extension.
assert.match(p.EXTENSION_SUBSCRIBE, /"streamId":"Extension"/);
const allIds = [p.LOGGING_SUBSCRIBE, p.EXTENSION_SUBSCRIBE].map((s) => JSON.parse(s).id);
assert.equal(new Set(allIds).size, 2, "each streamListen needs its own id");
assert.equal(p.STDOUT_SUBSCRIBE, undefined, "Stdout is the daemon's job, not a stream we listen to");
assert.equal(p.STDERR_SUBSCRIBE, undefined, "same for Stderr");

// ---- a record with no error or stack ------------------------------------------------------------
// The VM Service sends both fields even when unused, as a Dart null rendered "null". Reading that
// literally printed a four-character `null` under every plain developer.log line.
const plain = JSON.stringify({
  method: "streamNotify",
  params: { streamId: "Logging", event: { logRecord: {
    loggerName: { valueAsString: "AppLog" },
    message: { valueAsString: "counter is now 1" },
    level: 0,
    error: { kind: "Null", valueAsString: "null" },
    stackTrace: { kind: "Null", valueAsString: "null" },
  } } },
});
const pl = p.parseLogRecord(plain);
assert.equal(pl.message, "counter is now 1");
assert.equal(pl.error, "", "an absent error is empty, not the string 'null'");
assert.equal(pl.stack, "", "an absent stack is empty, not the string 'null'");

// A message that IS the word null is a real message and must survive.
assert.equal(p.parseLogRecord(record("AppLog", "null", 0)).message, "null");

// ---- stack frames -----------------------------------------------------------------------------
// The shape a Dart trace actually has, taken from a real one.
const fr = p.parseStackFrame("#0      _MyHomePageState._logWithError (package:deck_flutter_test/main.dart:144:7)");
assert.equal(fr.num, "#0");
assert.equal(fr.what, "_MyHomePageState._logWithError");
assert.equal(fr.uri, "package:deck_flutter_test/main.dart");
assert.equal(fr.line, 144);
assert.equal(fr.column, 7);
assert.equal(fr.short, "main.dart:144", "the file name alone, not the whole package path");

// The column is optional in a Dart trace.
assert.equal(p.parseStackFrame("#3  foo.bar (dart:core/x.dart:9)").line, 9);
// A function name containing spaces and angle brackets — closures look like this.
assert.equal(
  p.parseStackFrame("#8      PointerRouter._dispatchEventToRoutes.<anonymous closure> (package:flutter/src/gestures/pointer_router.dart:140:9)").what,
  "PointerRouter._dispatchEventToRoutes.<anonymous closure>");
// Not a frame: ordinary log lines must render as themselves.
assert.equal(p.parseStackFrame("caught and logged"), null);
assert.equal(p.parseStackFrame("printed counter 3"), null);
assert.equal(p.parseStackFrame(""), null);

// Resolving a frame to a file. Only the project's OWN package, because nothing else is knowable
// from here — a wrong link is worse than none.
const CWD = "D:/Flutter/personal/deck_flutter_test";
assert.equal(p.frameFile("package:deck_flutter_test/main.dart", CWD, "deck_flutter_test"),
  `${CWD}/lib/main.dart`);
assert.equal(p.frameFile("package:deck_flutter_test/ui/home.dart", CWD, "deck_flutter_test"),
  `${CWD}/lib/ui/home.dart`, "a nested path keeps its subdirectories");
assert.equal(p.frameFile("package:flutter/src/material/ink_well.dart", CWD, "deck_flutter_test"), "",
  "a dependency lives in the pub cache, which this cannot locate");
assert.equal(p.frameFile("dart:ui/hooks.dart", CWD, "deck_flutter_test"), "", "the SDK is not resolvable");
assert.equal(p.frameFile("package:x/a.dart", "", "x"), "", "no cwd, no link");
assert.equal(p.frameFile("package:x/a.dart", CWD, ""), "", "no package name, no link");
// A file: uri is already a path. Windows drive letters lose the leading slash, POSIX keeps it.
assert.equal(p.frameFile("file:///D:/x/main.dart", CWD, "x"), "D:/x/main.dart");
assert.equal(p.frameFile("file:///home/me/main.dart", CWD, "x"), "/home/me/main.dart");
// A trailing separator on the cwd must not produce a doubled one.
assert.equal(p.frameFile("package:x/a.dart", "D:/proj/", "x"), "D:/proj/lib/a.dart");

// ---- the log filter ----------------------------------------------------------------------------
const fout = await build({
  entryPoints: ["src/filter.ts"],
  bundle: true, format: "esm", write: false, platform: "node",
});
const f = await import(
  `data:text/javascript;base64,${Buffer.from(fout.outputFiles[0].text).toString("base64")}`
);

// Plain text is the default, and case-insensitive — a filter box is normally given a word.
assert.ok(f.matcher("setState")("calling setState now"));
assert.ok(f.matcher("SETSTATE")("calling setState now"), "plain search ignores case");
assert.ok(!f.matcher("setState")("nothing here"));
assert.ok(f.matcher("")("anything"), "an empty filter matches everything");
assert.ok(f.matcher("   ")("anything"), "whitespace only is still empty");

// The reason plain text is NOT treated as a pattern: these characters are common in log lines.
assert.ok(!f.matcher("a.c")("abc"), "a dot in plain text is a literal dot, not a wildcard");
assert.ok(f.matcher("a.c")("xxa.cxx"));
assert.ok(f.matcher("main(")("void main() {}"), "an unbalanced paren must not throw");

// Slashes opt in to a regex.
assert.ok(f.matcher("/^AppLog$/")("AppLog"));
assert.ok(!f.matcher("/^AppLog$/")("MyAppLogger"), "anchors must actually anchor");
assert.ok(f.matcher("/setState.*null/")("setState called with null"));
assert.ok(f.matcher("/APPLOG/i")("applog"), "flags are honoured");
assert.ok(!f.matcher("/APPLOG/")("applog"), "and absent flags are not assumed");

// `g` is stripped: with it, a shared regex alternates hit/miss across calls via lastIndex, so the
// same line would match on one render and vanish on the next.
const g = f.matcher("/counter/g");
assert.ok(g("counter is 1"));
assert.ok(g("counter is 2"), "a global flag must not make matching stateful");
assert.ok(g("counter is 3"));

// A half-typed pattern falls back to a literal search rather than throwing mid-keystroke.
assert.ok(f.matcher("/foo[")("a /foo[ b"), "an invalid regex searches literally");
assert.doesNotThrow(() => f.matcher("/*/")("x"));

// The two the UI needs apart: `.*` lights up on SYNTAX, the warning shows when that syntax does
// not compile. Conflating them would either hide the switch on a half-typed pattern or claim a
// plain-text query was broken.
assert.ok(f.regexSyntax("/foo/"), "slashes are the syntax");
assert.ok(f.regexSyntax("/foo/gi"), "flags are part of it");
assert.ok(!f.regexSyntax("foo"), "plain text is not");
assert.ok(!f.regexSyntax("/foo"), "one slash is not a delimited pattern");
assert.ok(!f.regexSyntax("http://x/y"), "a URL typed as a plain search must not read as regex");

assert.ok(f.validRegex("/foo.*bar/i"));
assert.ok(f.validRegex("//"), "the empty pattern the .* button inserts must be valid");
assert.ok(!f.validRegex("/foo[/"), "an unclosed class does not compile");
assert.ok(!f.validRegex("foo"), "plain text has nothing to compile");

// Regex-shaped but not compiling is exactly the state the warning is for.
assert.ok(f.regexSyntax("/foo[/") && !f.validRegex("/foo[/"),
  "a broken pattern must read as regex syntax AND as invalid");

// ---- finding apps inside a workspace ---------------------------------------------------------
// A package's example/ is the runnable app, and the package itself is not — both have a pubspec
// that names flutter, which is why the search also needs lib/main.dart before offering one.
assert.ok(d.isFlutterPubspec("name: a\ndependencies:\n  flutter:\n    sdk: flutter\n"));
assert.ok(d.isFlutterPubspec("name: a\nflutter:\n  assets:\n    - x.png\n"), "the flutter: section alone");
assert.ok(!d.isFlutterPubspec("name: a\ndependencies:\n  http: ^1.0.0\n"), "a pure Dart package");
assert.ok(!d.isFlutterPubspec("name: a\ndescription: Shared models for our flutter apps.\n"),
  "the word flutter in a description is not a flutter dependency");

assert.ok(d.shouldDescend("packages") && d.shouldDescend("example") && d.shouldDescend("apps"));
// These hold copies of plugin pubspecs; descending would offer every dependency as an app.
for (const n of ["build", "ios", "android", "windows", ".dart_tool", ".git", "node_modules"]) {
  assert.ok(!d.shouldDescend(n), `${n} is never searched`);
}

// ---- which workspace a run belongs to ---------------------------------------------------------
const wss = [
  { id: "mono", cwd: String.raw`D:\Flutter\hapster` },
  { id: "pkg", cwd: String.raw`D:\Flutter\hapster\packages\video_trimmer` },
  { id: "other", cwd: "D:/Flutter/personal/deck/" },
  { id: "home", cwd: "" },
];
const trimmer = String.raw`d:\flutter\hapster\packages\video_trimmer\example`;
assert.ok(d.runIsHere(wss, "mono", "D:/Flutter/hapster/hapster-mobile"));
assert.ok(d.runIsHere(wss, "mono", trimmer), "the outer folder shows a run a nested workspace also holds");
assert.ok(d.runIsHere(wss, "pkg", trimmer), "and so does the nested workspace");
assert.ok(!d.runIsHere(wss, "pkg", "D:/Flutter/hapster/hapster-mobile"), "a nested workspace shows only its own");
assert.ok(d.runIsHere(wss, "mono", String.raw`D:\Flutter\hapster`), "the workspace's own folder");
assert.ok(!d.runIsHere(wss, "other", "D:/Flutter/hapster/hapster-mobile"), "another workspace's run is not here");
assert.ok(!d.runIsHere([...wss, { id: "sib", cwd: "D:/Flutter/hapster-other" }], "mono", "D:/Flutter/hapster-other/app"),
  "a sibling folder sharing a prefix is not inside it");
assert.ok(d.runIsHere(wss, "other", "C:/elsewhere"), "a run no workspace holds shows everywhere");
assert.ok(!d.runIsHere(wss, "home", "D:/Flutter/hapster/hapster-mobile"), "an empty folder holds nothing");

// ---- naming an app in the picker --------------------------------------------------------------
assert.equal(d.appLabel(String.raw`D:\Flutter\hapster`, String.raw`D:\Flutter\hapster\packages\video_trimmer\example`),
  "packages/video_trimmer/example");
assert.equal(d.appLabel("D:/Flutter/hapster/hapster-mobile", String.raw`D:\Flutter\hapster\hapster-mobile`),
  "hapster-mobile", "the root is named by its folder");

// ---- the HTTP profile (net.ts) ------------------------------------------------------------------
// Shapes copied from a real `ext.dart.io.getHttpProfile` reply (Dart 3.12, profile version 4.0).
const netOut = await build({ entryPoints: ["src/net.ts"], bundle: true, format: "esm", write: false, platform: "node" });
const n = await import(`data:text/javascript;base64,${Buffer.from(netOut.outputFiles[0].text).toString("base64")}`);
const done = {
  type: "@HttpProfileRequest", id: "7", isolateId: "isolates/1", method: "POST", uri: "https://api.test/post?i=7",
  startTime: 1_000_000_000, endTime: 1_000_003_000,
  request: { headers: { "content-type": ["application/json"], host: ["api.test"] }, contentLength: -1 },
  response: { startTime: 1_000_150_000, endTime: 1_000_156_000, statusCode: 201, reasonPhrase: "Created",
    headers: { "content-type": ["application/json"], "set-cookie": ["a=1", "b=2"] }, contentLength: 506 },
};
const c = n.toCall(done);
assert.equal(c.start, 1_000_000, "microseconds become milliseconds");
assert.equal(n.duration(c), 156, "the call ends when the response does, not when the request was sent");
assert.equal(c.status, 201);
assert.equal(c.resHeaders["set-cookie"], "a=1, b=2", "a repeated header reads as one line");
assert.equal(c.reqSize, -1);
const flying = n.toCall({ ...done, id: "8", endTime: undefined, response: undefined });
assert.equal(n.duration(flying), undefined, "a call in flight has no duration yet");
assert.equal(flying.status, undefined);
const failed = n.toCall({ ...done, id: "9", response: undefined, request: { ...done.request, error: "SocketException: Failed host lookup" } });
assert.equal(failed.error, "SocketException: Failed host lookup", "a failed call says why");
assert.equal(n.duration(failed), 3, "and ends when it failed");

const prof = n.parseProfile({ type: "HttpProfile", timestamp: 1_000_200_000, requests: [done, { ...done, id: "8", response: undefined }] });
assert.equal(prof.since, 1_000_200_000, "the next read asks only for what changed since this one");
assert.equal(prof.calls.length, 2);

// Merging an update: the in-flight call is replaced in place when it finishes, a new one appended.
let list = n.mergeCalls([], [flying], 1000);
list = n.mergeCalls(list, [n.toCall({ ...done, id: "8" }), c], 1000);
assert.deepEqual(list.map((x) => [x.id, x.status]), [["8", 201], ["7", 201]]);
assert.equal(n.mergeCalls(list, [], 1000), list, "nothing new keeps the same list, so nothing re-renders");
assert.deepEqual(n.mergeCalls(list, [n.toCall({ ...done, id: "10" })], 2).map((x) => x.id), ["7", "10"], "capped, oldest dropped");
assert.equal(n.mergeCalls([c], [{ ...c, isolateId: "isolates/2" }], 9).length, 2, "ids are per isolate");

const bytes = (s) => [...Buffer.from(s)];
assert.equal(n.bodyText(bytes('{"a":1}'), "application/json"), '{\n  "a": 1\n}', "JSON is pretty-printed");
assert.equal(n.bodyText(bytes("plain"), "text/plain"), "plain");
assert.equal(n.bodyText(bytes("xxxx"), "image/png"), "(4 bytes of image/png)", "an image is not shown as text");
assert.match(n.bodyText(bytes("abcdef"), "text/plain", 3), /^abc\n… 3 more bytes not shown$/, "a big body is cut");
assert.equal(n.bodyText(undefined), "");

assert.equal(n.curlOf(c, `{"it's":1}`),
  `curl -X POST 'https://api.test/post?i=7' -H 'content-type: application/json' --data-raw '{"it'\\''s":1}'`,
  "cURL keeps the headers that matter and quotes for a shell");
assert.equal(n.curlOf({ ...c, method: "GET" }), `curl 'https://api.test/post?i=7' -H 'content-type: application/json'`);

console.log("flutter.check.mjs: all assertions passed");
