// Flutter: launch an app on a device, watch its logs, and hot reload it.
//
// All of this used to be built into Deck — an `is_flutter_run` match in the Rust terminal sweep,
// a core/flutterrun.ts, a FlutterBar component and a `hotReloadOnSave` setting. Deck now exposes
// only general facts (the processes each pane owns, a streamable child process, a save event)
// and knows nothing about Flutter. This is the toolchain-specific half.
//
// TWO KINDS OF RUN, deliberately both:
//
//   daemon  — started from here. Deck spawns `flutter run --machine` with its stdin open, so the
//             plugin speaks the daemon protocol: reload is a JSON command, and the VM Service
//             Logging stream is attached, which is the only way to see `developer.log` output.
//   pane    — a `flutter run` you started yourself in a terminal. Recognised from the process
//             sweep; driven by writing the keypress `r`, since that is all a terminal run takes.
//
// The second is not a fallback for the first. Typing `flutter run` in a pane is a normal thing to
// do, and the footer buttons should work for it.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Zap, RotateCw, Square, Play, Smartphone, Monitor, Globe, X, Copy, Trash2, WrapText, Clock,
} from "lucide-react";
import { configRead, exec, fsList, fsRead, type ExecOut } from "../shim/bridge.js";
import { termWrite, getLayout, useLayout, type Layout } from "../shim/terminals.js";
import {
  isFlutterRun, runForFile, parseDevices, isFlutterPubspec, shouldDescend, ownerWorkspace, appLabel,
  type Device, type FlutterRun, type PaneProcs,
} from "./detect.js";
import { ContextMenu, type MenuEntry } from "../shim/ui.js";
import { parseStackFrame, frameFile } from "./daemon.js";
import * as store from "./store.js";
import { matcher, regexSyntax, validRegex } from "./filter.js";

/** How often to re-read which panes are running an app. Matches Deck's sweep interval. */
const POLL_MS = 10_000;

/** The workspace + pane a pane id belongs to, for its cwd and a readable label. */
function paneInfo(l: Layout | null, id: string): { cwd: string; wsId: string; label: string } | null {
  if (!l) return null;
  for (const w of l.workspaces) {
    for (const t of w.tabs) {
      const walk = (n: typeof t.root): string | null =>
        n.kind === "leaf" ? (n.id === id ? (n.label || t.title) : null) : (walk(n.a) ?? walk(n.b));
      const hit = walk(t.root);
      if (hit) return { cwd: w.cwd, wsId: w.id, label: `${w.name} · ${hit}` };
    }
  }
  return null;
}

/** Every pane running `flutter run`, from Deck's process sweep. */
async function findPaneRuns(l: Layout | null): Promise<FlutterRun[]> {
  let procs: PaneProcs = {};
  try {
    const t = await configRead("term-procs");
    procs = t.trim() ? (JSON.parse(t) as PaneProcs) : {};
  } catch { return []; }
  return Object.entries(procs)
    .filter(([, rows]) => rows.some(isFlutterRun))
    .map(([paneId]) => {
      const info = paneInfo(l, paneId);
      return { paneId, cwd: info?.cwd ?? "", wsId: info?.wsId ?? "", label: info?.label ?? "flutter run" };
    });
}

/**
 * The Flutter apps in a workspace: its own folder, and any nested under it.
 *
 * A workspace is often not one app. A package's runnable app is its example/, a monorepo keeps
 * apps under apps/ or beside packages/, and the workspace root may have no pubspec at all — so
 * asking only "is the root a Flutter project" both missed apps and offered packages that cannot
 * be run. An app here is a pubspec that names flutter AND a lib/main.dart.
 *
 * Breadth-first to a fixed depth, skipping build output and platform folders (see shouldDescend).
 * ponytail: depth 3 and a cap on folders visited bound the cost on a huge tree; an app deeper than
 * that is not offered, and the fix is raising MAX_DEPTH, not a smarter walk.
 *
 * Cached per workspace folder because `panelWhen` is synchronous and runs on every footer render.
 * The picker re-scans each time it opens, so an app created mid-session appears there.
 */
const appsCache = new Map<string, string[]>();
const MAX_DEPTH = 3;
const MAX_DIRS = 400;

/** The active workspace's directory, read straight from the layout store. */
function currentCwd(): string {
  const l = getLayout();
  return l?.workspaces.find((w) => w.id === l.activeWs)?.cwd ?? "";
}

async function isApp(dir: string, entries: { name: string; dir: boolean }[]): Promise<boolean> {
  if (!entries.some((e) => !e.dir && e.name === "pubspec.yaml")) return false;
  if (!entries.some((e) => e.dir && e.name === "lib")) return false;
  try {
    if (!isFlutterPubspec(await fsRead(`${dir}/pubspec.yaml`))) return false;
    return (await fsList(`${dir}/lib`)).some((e) => !e.dir && e.name === "main.dart");
  } catch { return false; }
}

async function scanApps(root: string): Promise<string[]> {
  if (!root) return [];
  const found: string[] = [];
  let level = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_DEPTH && level.length && visited < MAX_DIRS; depth++) {
    const next: string[] = [];
    await Promise.all(level.map(async (dir) => {
      visited++;
      let entries: { name: string; path: string; dir: boolean }[] = [];
      try { entries = await fsList(dir); } catch { return; }
      if (await isApp(dir, entries)) found.push(dir);
      for (const e of entries) if (e.dir && shouldDescend(e.name)) next.push(e.path);
    }));
    level = next;
  }
  // The root first, then the rest by path, so the order is the same every time it opens.
  found.sort((a, b) => (a === root ? -1 : b === root ? 1 : a.localeCompare(b)));
  appsCache.set(root, found);
  return found;
}

/** The cached answer when there is one, else a scan. */
const appsIn = (root: string) => {
  const seen = appsCache.get(root);
  return seen ? Promise.resolve(seen) : scanApps(root);
};

/**
 * The project's own package name, from pubspec.yaml — what a `package:` stack frame is prefixed
 * with when the code is the app's rather than a dependency's.
 *
 * Cached per directory like the project check above: a stack trace asks for this once per frame,
 * and the file does not change while an app is running.
 */
const packageCache = new Map<string, string>();

async function packageName(cwd: string): Promise<string> {
  if (!cwd) return "";
  const seen = packageCache.get(cwd);
  if (seen !== undefined) return seen;
  let name = "";
  try {
    // The first `name:` at the start of a line. pubspec's own top-level key, not a nested one.
    name = /^name:\s*(\S+)/m.exec(await fsRead(`${cwd}/pubspec.yaml`))?.[1] ?? "";
  } catch { name = ""; }
  packageCache.set(cwd, name);
  return name;
}

const ICONS: Record<string, typeof Monitor> = {
  windows: Monitor, macos: Monitor, linux: Monitor,
  web: Globe, android: Smartphone, ios: Smartphone,
};
const deviceIcon = (platform: string) => ICONS[platform.split("-")[0]] ?? Smartphone;

/** Subscribe to the runs store. */
const useRuns = () => useSyncExternalStore(store.subscribe, store.getRuns);

/**
 * The runs that belong to the active workspace — the one whose folder holds the run's — plus any
 * run no workspace claims.
 *
 * Without this, opening another workspace showed the first one's apps, and its buttons reloaded
 * them. The unclaimed ones are shown everywhere rather than nowhere: an agent can start a run in
 * any folder, and a run nobody can see is a run nobody can stop.
 */
function runsHere(runs: store.Run[], l: Layout | null): store.Run[] {
  if (!l) return runs;
  return runs.filter((r) => {
    const owner = ownerWorkspace(l.workspaces, r.cwd);
    return owner === null || owner === l.activeWs;
  });
}

/** The pane runs, polled. Shared by the tab and the footer. */
function usePaneRuns() {
  const [all, setAll] = useState<FlutterRun[]>([]);
  useEffect(() => {
    let alive = true;
    const scan = () => { void findPaneRuns(getLayout()).then((r) => { if (alive) setAll(r); }); };
    scan();
    const t = setInterval(scan, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return all;
}

/**
 * Hot reload on save, for both kinds of run.
 *
 * Registered once at module scope rather than in a component: the tab unmounts on navigation, and
 * a reload-on-save that only works while you are looking at the Flutter tab is worse than none.
 */
let saveWired = false;
function wireSaveReload() {
  if (saveWired) return;
  saveWired = true;
  window.addEventListener("deck-file-saved", (e) => {
    const path = (e as CustomEvent<{ path: string }>).detail?.path;
    if (!path || !reloadOnSave) return;

    // A daemon run owns the file? Reload through the protocol.
    const daemon = store.getRuns().filter((r) => r.status === "running");
    const owner = runForFile(
      daemon.map((r) => ({ paneId: r.id, cwd: r.cwd, wsId: "", label: r.deviceName })), path);
    if (owner) { store.reload(owner.paneId); return; }

    // Otherwise a pane run, driven by the keypress.
    void findPaneRuns(getLayout()).then((rs) => {
      const run = runForFile(rs, path);
      if (run) void termWrite(run.paneId, "r").catch(() => {});
    });
  });
}

/**
 * Whether saving reloads. Plugin-owned: this used to be a Deck setting, which meant Deck shipped
 * a checkbox describing a toolchain it otherwise knew nothing about.
 *
 * ponytail: a module-level boolean plus a config file, not a settings store. One flag, one reader.
 */
let reloadOnSave = true;
const RELOAD_KEY = "plugin-flutter";
void configRead(RELOAD_KEY)
  .then((t) => { if (t.trim()) reloadOnSave = JSON.parse(t).reloadOnSave !== false; })
  .catch(() => {});

wireSaveReload();

/**
 * Pick an app and a device, then launch. Used from the footer readout and the panel.
 *
 * With one app in the workspace the menu is just its devices. With several, each app is a row
 * whose submenu is the devices, so running a package's example/ is two clicks rather than
 * impossible.
 *
 * Deck's own ContextMenu rather than a hand-placed box: it flips and clamps to the window. The
 * box this replaced always opened upward, which suited the footer and clipped off the top of the
 * screen when the panel sat in a pane near the top.
 */
function DevicePicker({ root, onPick, children }: {
  root: string;
  onPick: (app: string, d: Device) => void;
  children: React.ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [apps, setApps] = useState<string[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const open = at !== null;

  // Both fetched when the menu opens, never on a poll: `flutter devices` probes adb and the
  // browsers and takes several seconds, which is fine once on a click and not fine every 10s.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setApps(null);
    setDevices(null);
    void scanApps(root).then((a) => {
      if (!alive) return;
      setApps(a);
      exec("flutter", ["devices", "--machine"], a[0] ?? root)
        .then((r: ExecOut) => { if (alive) setDevices(parseDevices(r.stdout)); })
        .catch(() => { if (alive) setDevices([]); });
    });
    return () => { alive = false; };
  }, [open, root]);

  const toggle = () => {
    if (open || !anchor.current) { setAt(null); return; }
    const r = anchor.current.getBoundingClientRect();
    // Raised from whichever edge has room, so it opens away from the button rather than over it.
    const below = window.innerHeight - r.bottom;
    setAt({ x: r.right, y: below >= r.top ? r.bottom + 4 : r.top - 4 });
  };

  const deviceItems = (app: string): MenuEntry[] => {
    if (devices === null) return [{ label: "Finding devices…", disabled: true }];
    if (!devices.length) return [{ label: "No devices found", disabled: true }];
    return devices.map((d) => ({
      label: d.name,
      subLabel: d.emulator ? "emulator" : undefined,
      icon: deviceIcon(d.platform),
      onClick: () => { setAt(null); onPick(app, d); },
    }));
  };

  const items: MenuEntry[] =
    apps === null ? [{ label: "Looking for apps…", disabled: true }]
    : !apps.length ? [{ label: "No Flutter app in this workspace", disabled: true }]
    : apps.length === 1 ? deviceItems(apps[0])
    : apps.map((a) => ({ label: appLabel(root, a), icon: Smartphone, children: deviceItems(a) }));

  return (
    <>
      <button ref={anchor} onClick={toggle} onMouseDown={(e) => e.stopPropagation()}
        title="Run a Flutter app">{children}</button>
      {at && <ContextMenu x={at.x} y={at.y} alignRight items={items} onClose={() => setAt(null)} />}
    </>
  );
}

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Whether this line repeats the previous one's timestamp and logger.
 *
 * A stack trace is 22 lines that all came from ONE log call, so stamping every frame with the
 * same time and the same [AppLog] triples the width of the line and buries what is being read.
 * Same second, same logger, same level is close enough — two unrelated records landing in the
 * same second is exactly the case where a shared heading is also fair.
 */
function sameHead(l: store.LogLine, prev?: store.LogLine): boolean {
  if (!prev) return false;
  const a = l.appTs ?? l.ts;
  const b = prev.appTs ?? prev.ts;
  return l.logger === prev.logger && l.kind === prev.kind && Math.floor(a / 1000) === Math.floor(b / 1000);
}

/**
 * One line's text: a stack frame laid out like an IDE, anything else as written.
 *
 * A frame reads "#0 <function> (package:foo/main.dart:144:7)", which puts the longest and least
 * interesting part — the uri — in the middle of the line. This pulls the location to the right,
 * where it lines up down the trace and can be clicked.
 *
 * Only a frame in the project's OWN code is a link. `dart:ui` and the pub cache are not resolvable
 * from here, and a link that opens nothing is worse than plain text.
 */
function LogText({ line, cwd, pkg }: { line: store.LogLine; cwd: string; pkg: string }) {
  const f = parseStackFrame(line.text);
  if (!f) return <span className={`min-w-0 flex-1 ${LOG_COLOR[line.kind]}`}>{line.text}</span>;

  const file = frameFile(f.uri, cwd, pkg);
  const open = () => {
    if (!file) return;
    window.dispatchEvent(new CustomEvent("deck-term-open",
      { detail: { path: file, line: f.line }, cancelable: true }));
  };

  return (
    <>
      <span className="shrink-0 text-text-muted">{f.num}</span>
      <span className={`min-w-0 flex-1 truncate ${LOG_COLOR[line.kind]}`} title={f.what}>{f.what}</span>
      {file ? (
        <button onClick={open} title={`${f.uri}:${f.line}:${f.column}\nOpen in the editor`}
          className="shrink-0 text-text-muted underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]">
          {f.short}
        </button>
      ) : (
        <span className="shrink-0 text-text-muted opacity-60" title={f.uri}>{f.short}</span>
      )}
    </>
  );
}

/** Colour per log kind. Mirrors what the terminal wrapper used, so the output reads the same. */
const LOG_COLOR: Record<store.LogLine["kind"], string> = {
  shout: "text-fuchsia-400",
  error: "text-red-400",
  warn: "text-amber-400",
  info: "text-amber-200/80",
  fine: "text-text-muted",
  log: "text-sky-300",
  progress: "text-cyan-400",
  deck: "text-emerald-400",
  raw: "text-text-secondary",
};

/**
 * What the panel looked like last time: which run was selected, the filter, the clock and wrap.
 *
 * `Panel` unmounts whenever the drawer closes, the module changes or its pane goes away, while
 * the runs it is showing live on in the store — so without this every one of these resets while
 * the thing being looked at is still running.
 *
 * localStorage rather than the synced config, for the reason `src/core/httpsession.ts` gives:
 * this is per-machine view state and has no business reaching the phone or the VPS. A stale
 * `selected` after a restart is harmless — the render already falls back to `runs[0]`.
 *
 * ponytail: one key, one object, read once at module scope. Two Panels can be mounted at once
 * (the drawer and a pane both render this) and they do NOT sync live — whichever writes last
 * wins, and the other picks it up on its next mount. Not worth a subscription.
 */
const PREFS_KEY = "deck.flutter.panel";
type Prefs = { selected: string | null; q: string; wrap: boolean; clock: "app" | "deck" | "off" };
const prefs: Partial<Prefs> = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>; }
  catch { return {}; }
})();

/**
 * The footer drawer panel: a run's log, with the controls for it.
 *
 * A drawer rather than a module tab because that is what this output is for — you watch it while
 * working in the editor, not by navigating away from it. It opens over the module instead of
 * resizing it, and it keeps running when you switch tabs, both of which a module cannot do.
 */
export function Panel() {
  const layout = useLayout();
  const runs = runsHere(useRuns(), layout);
  const [selected, setSelected] = useState<string | null>(prefs.selected ?? null);
  const [launchable, setLaunchable] = useState(false);
  const [q, setQ] = useState(prefs.q ?? "");
  const [wrap, setWrap] = useState(prefs.wrap ?? true);
  /**
   * Which clock the timestamp column shows, or none at all.
   *
   * "app" is when the app logged the line, "deck" is when Deck received it. They disagree when
   * records queue behind a flood, and only a line off the Logging stream knows the first — so
   * "app" falls back to Deck's clock rather than leaving a gap.
   */
  const [clock, setClock] = useState<"app" | "deck" | "off">(prefs.clock ?? "app");
  /** The running project's package name, for resolving `package:` frames to files on disk. */
  const [pkg, setPkg] = useState("");
  const wsCwd = layout?.workspaces.find((w) => w.id === layout.activeWs)?.cwd ?? "";

  const active = runs.find((r) => r.id === selected) ?? runs[0] ?? null;

  useEffect(() => {
    let alive = true;
    void appsIn(wsCwd).then((a) => { if (alive) setLaunchable(a.length > 0); });
    return () => { alive = false; };
  }, [wsCwd]);

  // Read from the RUN's directory, not the active workspace's: the drawer keeps showing a run
  // after you navigate elsewhere, and the frames belong to whatever is running.
  useEffect(() => {
    let alive = true;
    void packageName(active?.cwd ?? "").then((n) => { if (alive) setPkg(n); });
    return () => { alive = false; };
  }, [active?.cwd]);

  // Remember the view. Assigned into the module object too, so a second Panel mounting later in
  // this session starts from these rather than from whatever was on disk at startup.
  useEffect(() => {
    Object.assign(prefs, { selected, q, wrap, clock });
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* quota / private mode */ }
  }, [selected, q, wrap, clock]);

  const lines = active?.log ?? [];
  // Matched against the logger name too, so `/^AppLog$/` narrows to one logger's output.
  const match = matcher(q);
  const shown = q.trim()
    ? lines.filter((l) => match(l.text) || match(l.logger ?? ""))
    : lines;

  // Follow the tail — but only when already at the bottom, so scrolling back to read something is
  // not yanked away by the next line of output. A ref, not state: it changes on every scroll and
  // re-rendering the log for it would be the most expensive thing in the panel.
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const onScroll = () => {
    const el = logRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  // Ctrl+C on a selection. Deck runs in a WebView2 with no application menu, so the native copy
  // accelerator never fires — without this you can highlight log text but not copy it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return;
    const text = window.getSelection()?.toString();
    if (!text) return;
    e.preventDefault();
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  /** Copy the whole visible log — what is actually on screen, filters included. */
  const copyAll = () => {
    // Copies what is on screen, the clock choice included — a pasted log that disagrees with the
    // panel it came from is worse than one with no timestamps at all.
    const text = shown.map((l) => {
      const stamp = clock === "off" ? "" : `${time(clock === "app" ? l.appTs ?? l.ts : l.ts)} `;
      return `${stamp}${l.logger ? `[${l.logger}] ` : ""}${l.text}`;
    }).join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  if (!runs.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
        <Zap size={28} className="opacity-40" />
        <p className="text-sm">No app running.</p>
        {launchable ? (
          <DevicePicker root={wsCwd}
            onPick={(app, d) => { void store.start(app, d.id, d.name).then(setSelected); }}>
            <span className="flex items-center gap-1.5 rounded bg-white/10 px-3 py-1.5 text-xs text-text-primary hover:bg-white/15">
              <Play size={12} /> Run on a device
            </span>
          </DevicePicker>
        ) : (
          <p className="text-xs">No Flutter app in this workspace.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Run switcher + controls */}
      <div className="flex items-center gap-1 border-b border-subtle px-2 py-1.5">
        {runs.map((r) => {
          const Icon = deviceIcon(r.deviceId);
          return (
            <button key={r.id} onClick={() => setSelected(r.id)}
              className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] ${
                r.id === active?.id ? "bg-white/10 text-text-primary" : "text-text-muted hover:bg-white/5"}`}>
              <Icon size={11} />
              {r.deviceName}
              <span className={r.status === "running" ? "text-emerald-400" : "text-text-muted"}>
                {r.status === "running" ? "●" : r.status === "ended" ? "○" : "◐"}
              </span>
            </button>
          );
        })}
        <div className="flex-1" />
        {active && active.status !== "ended" && (
          <>
            <button onClick={() => store.reload(active.id)} title="Hot reload"
              className="grid h-6 w-6 place-items-center rounded text-text-secondary hover:bg-white/10 hover:text-text-primary">
              <Zap size={12} />
            </button>
            <button onClick={() => store.restart(active.id)} title="Hot restart"
              className="grid h-6 w-6 place-items-center rounded text-text-secondary hover:bg-white/10 hover:text-text-primary">
              <RotateCw size={12} />
            </button>
            <button onClick={() => store.stop(active.id)} title="Stop"
              className="grid h-6 w-6 place-items-center rounded text-text-secondary hover:bg-white/10 hover:text-red-400">
              <Square size={10} />
            </button>
          </>
        )}
        {active?.status === "ended" && (
          <>
            {/* Run the same project on the same device again, without going back through the
                device picker. `active.cwd`, not `wsCwd`: a run may have been started from a
                different workspace, and "again" means the project it actually ran. */}
            <button
              onClick={() => {
                // Start BEFORE dismissing. `start` is async (it awaits the event wiring) while
                // `dismiss` publishes synchronously, so dropping the old run first would leave
                // `runs` empty for a render and flash the "No app running" screen.
                const old = active.id;
                void store.start(active.cwd, active.deviceId, active.deviceName)
                  .then((id) => { store.dismiss(old); setSelected(id); });
              }}
              title={`Run again on ${active.deviceName}`}
              className="grid h-6 w-6 place-items-center rounded text-text-secondary hover:bg-white/10 hover:text-text-primary">
              <RotateCw size={12} />
            </button>
            <button onClick={() => store.dismiss(active.id)} title="Close this run"
              className="grid h-6 w-6 place-items-center rounded text-text-secondary hover:bg-white/10 hover:text-text-primary">
              <X size={12} />
            </button>
          </>
        )}
        {launchable && (
          <DevicePicker root={wsCwd}
            onPick={(app, d) => { void store.start(app, d.id, d.name).then(setSelected); }}>
            <span className="grid h-6 w-6 place-items-center rounded text-text-secondary hover:bg-white/10 hover:text-text-primary">
              <Play size={12} />
            </span>
          </DevicePicker>
        )}
      </div>

      {/* Filter and log actions. */}
      <div className="flex items-center gap-1.5 border-b border-subtle px-2 py-1">
        <div className="relative flex items-center">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter logs…"
            spellCheck={false}
            className="w-60 rounded border border-subtle bg-card py-0.5 pl-2 pr-8 font-mono text-[11px] text-text-primary outline-none placeholder:font-sans placeholder:text-text-muted focus:border-accent-soft"
          />
          {/*
            The regex switch, as a button rather than a hint: the syntax is slashes around the
            pattern, which nothing on screen would otherwise tell you. Clicking wraps or unwraps
            what is already typed, so the shape is learned by watching it happen once.
          */}
          <button
            onClick={() => setQ((v) => {
              const t = v.trim();
              if (!t) return "//";
              return regexSyntax(t) ? t.replace(/^\/(.*)\/[gimsuy]*$/, "$1") : `/${t}/i`;
            })}
            title={regexSyntax(q)
              ? "Using a regular expression — click to go back to plain text"
              : "Match with a regular expression (wraps the text in /slashes/)"}
            className="absolute right-1 rounded px-1 py-0.5 font-mono text-[10px] transition-colors hover:bg-white/10"
            style={{ color: regexSyntax(q) ? "var(--accent)" : "var(--text-muted)" }}
          >
            .*
          </button>
        </div>
        <span className="text-[10px] text-text-muted">
          {shown.length}{shown.length !== lines.length && ` / ${lines.length}`} lines
        </span>
        {/* A pattern that cannot compile searches literally; saying so beats silently doing it. */}
        {regexSyntax(q) && !validRegex(q) && (
          <span className="text-[10px] text-amber-400">incomplete pattern — matching literally</span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {/* Three states on one button rather than a menu: it is two bits of state, and the
              tooltip names what the next click does. */}
          <button
            onClick={() => setClock((v) => (v === "app" ? "deck" : v === "deck" ? "off" : "app"))}
            title={clock === "app" ? "Showing when the app logged each line — click for Deck's receive time"
              : clock === "deck" ? "Showing when Deck received each line — click to hide the column"
              : "Timestamps hidden — click to show when the app logged each line"}
            className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary"
            style={clock !== "off" ? { color: clock === "deck" ? "var(--accent)" : "var(--text-primary)" } : undefined}>
            <Clock size={12} />
          </button>
          <button onClick={() => setWrap((v) => !v)} title={wrap ? "Stop wrapping long lines" : "Wrap long lines"}
            className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary"
            style={wrap ? { color: "var(--text-primary)" } : undefined}>
            <WrapText size={12} />
          </button>
          <button onClick={copyAll} title="Copy what is shown"
            className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary">
            <Copy size={12} />
          </button>
          {active && (
            <button onClick={() => store.clearLog(active.id)} title="Clear the log"
              className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary">
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {/* The log. tabIndex so the scroller can receive the copy keydown at all. */}
      <div ref={logRef} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown}
        className={`scroll-thin flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px] leading-[1.5] outline-none ${
          wrap ? "" : "overflow-x-auto"}`}>
        {shown.map((l, i) => (
          <div key={l.id}
            className={`flex gap-2 px-1 hover:bg-white/5 ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
            {clock !== "off" && (
              // Blank rather than absent on a repeat: the column keeps its width, so the text
              // stays aligned instead of stepping left on every continuation line.
              <span className="shrink-0 text-text-muted">
                {sameHead(l, shown[i - 1]) ? " ".repeat(8) : time(clock === "app" ? l.appTs ?? l.ts : l.ts)}
              </span>
            )}
            {l.logger && (
              <span className="shrink-0 text-text-muted">
                {sameHead(l, shown[i - 1]) ? " ".repeat(l.logger.length + 2) : `[${l.logger}]`}
              </span>
            )}
            <LogText line={l} cwd={active?.cwd ?? ""} pkg={pkg} />
          </div>
        ))}
        {!shown.length && (
          <div className="px-1 py-3 text-text-muted">
            {lines.length ? "Nothing matches this filter." : "Waiting for output…"}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The footer readout: controls for whatever is running, from any module.
 *
 * Prefers a daemon run (it has the richer protocol) and falls back to a pane run. In the footer
 * rather than floating over the app because a floating panel kept being covered by the full-bleed
 * Editor, and the footer is visible everywhere.
 */
export function Status() {
  const layout = useLayout();
  const daemonRuns = runsHere(useRuns(), layout).filter((r) => r.status !== "ended");
  const paneRuns = usePaneRuns().filter((r) => r.wsId === layout?.activeWs);
  const [busy, setBusy] = useState("");
  const wsCwd = layout?.workspaces.find((w) => w.id === layout.activeWs)?.cwd ?? "";

  // Always ask, even while something is running — the answer also decides whether the drawer tab
  // shows, and `panelWhen` reads it from the cache this fills. Resolving it here is what makes the
  // tab appear on the same render as the run button, rather than one workspace switch late.
  const [isProject, setIsProject] = useState(false);
  useEffect(() => {
    let alive = true;
    void appsIn(wsCwd).then((a) => { if (alive) setIsProject(a.length > 0); });
    return () => { alive = false; };
  }, [wsCwd]);
  const launchable = isProject && !daemonRuns.length && !paneRuns.length;

  const daemon = daemonRuns[0];
  const pane = paneRuns[0];

  if (!daemon && !pane) {
    return launchable ? (
      <DevicePicker root={wsCwd} onPick={(app, d) => { void store.start(app, d.id, d.name); }}>
        <span className="grid h-6 w-6 place-items-center rounded text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary">
          <Play size={12} />
        </span>
      </DevicePicker>
    ) : null;
  }

  const flash = (label: string) => { setBusy(label); setTimeout(() => setBusy(""), 600); };
  const act = (kind: "reload" | "restart" | "stop") => {
    flash(kind);
    if (daemon) {
      if (kind === "reload") store.reload(daemon.id);
      else if (kind === "restart") store.restart(daemon.id);
      else store.stop(daemon.id);
    } else if (pane) {
      void termWrite(pane.paneId, kind === "reload" ? "r" : kind === "restart" ? "R" : "q").catch(() => {});
    }
  };

  const btn = "grid h-6 w-6 place-items-center rounded transition-colors";
  const label = daemon ? `${daemon.deviceName} · ${daemon.status}` : pane?.label ?? "flutter run";
  return (
    <div className="flex items-center gap-0.5" title={label}>
      <button onClick={() => act("reload")} title="Hot reload (r)"
        className={btn + " text-text-secondary hover:bg-white/10 hover:text-text-primary"}
        style={busy === "reload" ? { color: "var(--accent)" } : undefined}>
        <Zap size={12} />
      </button>
      <button onClick={() => act("restart")} title="Hot restart (R)"
        className={btn + " text-text-secondary hover:bg-white/10 hover:text-text-primary"}
        style={busy === "restart" ? { color: "var(--accent)" } : undefined}>
        <RotateCw size={12} />
      </button>
      <button onClick={() => act("stop")} title="Stop the app (q)"
        className={btn + " text-text-secondary hover:bg-white/10 hover:text-red-400"}>
        <Square size={10} />
      </button>
    </div>
  );
}

/** The lucide icon for the drawer tab. */
export const panelIcon = "Zap";

/**
 * Whether the drawer tab is worth showing: a run exists, or the workspace is a Flutter project.
 *
 * Deck asks this on every footer render, so it has to answer from memory rather than the disk.
 * `isFlutterProject` reads pubspec.yaml and is async, so its verdict is cached per directory by
 * the readout that already calls it, and this reads that cache. A directory nobody has looked at
 * yet answers "no" and flips to "yes" on the next render after the read lands — which is the
 * same tick the run button appears on, so the two agree.
 */
export const panelWhen = () =>
  runsHere(store.getRuns(), getLayout()).length > 0 || (appsCache.get(currentCwd())?.length ?? 0) > 0;

/** Palette entries, so the buttons are reachable without the mouse. */
export function commands() {
  const first = () => runsHere(store.getRuns(), getLayout()).find((r) => r.status === "running");
  return [
    { id: "reload", title: "Flutter: Hot reload", run: () => { const r = first(); if (r) store.reload(r.id); } },
    { id: "restart", title: "Flutter: Hot restart", run: () => { const r = first(); if (r) store.restart(r.id); } },
    { id: "stop", title: "Flutter: Stop the app", run: () => { const r = first(); if (r) store.stop(r.id); } },
  ];
}

/**
 * The same log view, as a resizable pane in the Terminals split tree.
 *
 * Literally the drawer panel: the two want identical UI, and a second component that merely
 * looked the same would drift the first time either grew a control. The drawer is the glance —
 * it opens over whatever you are doing and closes again. A pane is the opposite: it holds a
 * place in the layout and survives restarts, which is what you want while you are working
 * against a running app rather than checking on one.
 */
export const PaneView = Panel;
