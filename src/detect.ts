// Recognising a `flutter run` in a terminal pane, and deciding which one owns a file.
//
// This is the knowledge that used to live in Deck's Rust sweep as `is_flutter_run`. Deck now
// publishes the raw process rows per pane (term-procs.json) and says nothing about what they
// mean, so the toolchain-specific part is here — which is the whole point of the plugin.
//
// Pure functions, no Deck imports: everything here is decided from data the caller passes in,
// so detect.check.mjs can test it without the app running.

/** One process row as Deck's sweep publishes it. */
export interface PaneProc { name: string; cmd: string }
/** term-procs.json: the processes each pane owns, shells excluded. */
export type PaneProcs = Record<string, PaneProc[]>;

export interface FlutterRun {
  paneId: string;
  /** The pane's working directory — the project this run belongs to. */
  cwd: string;
  /** The workspace holding the pane, so a readout can show only the current one's runs. */
  wsId: string;
  /** "workspace · pane", for labelling. */
  label: string;
}

/** Trailing separators and case dropped, backslashes normalised, so two spellings compare equal. */
export const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Is this process row the dart process of a `flutter run`?
 *
 * Matching on dart.exe alone is not enough: the editor's language server and flutter's own
 * development-service are dart.exe too. The flutter TOOL is identified by its snapshot, and the
 * `run` subcommand separates a live app from `flutter pub get` / `flutter build`.
 *
 * `run` is matched as a whole word so a path containing "run" (a checkout under C:\runners\)
 * cannot pass — which is why this splits rather than calling includes().
 */
export function isFlutterRun(p: PaneProc): boolean {
  // dart.exe on Windows; dart elsewhere (the SDK's binary, which flutter's script runs).
  if (!["dart.exe", "dart"].includes(p.name.toLowerCase())) return false;
  const c = p.cmd.toLowerCase();
  return c.includes("flutter_tools.snapshot") && c.split(/\s+/).some((w) => w === "run");
}

/** Every pane id whose processes include a `flutter run`. */
export function runningPanes(procs: PaneProcs): string[] {
  return Object.entries(procs).filter(([, rows]) => rows.some(isFlutterRun)).map(([id]) => id);
}

/**
 * The run that owns a file: the pane whose workspace directory contains it.
 *
 * With several apps running at once this is what stops a save in one project reloading another.
 * Longest cwd wins, so a nested package beats the parent repo it sits inside.
 */
export function runForFile(runs: FlutterRun[], filePath: string): FlutterRun | null {
  const f = norm(filePath);
  const owning = runs.filter((r) => r.cwd && f.startsWith(norm(r.cwd) + "/"));
  if (!owning.length) return null;
  return owning.reduce((a, b) => (norm(b.cwd).length > norm(a.cwd).length ? b : a));
}

/** One device as `flutter devices --machine` reports it. */
export interface Device { id: string; name: string; platform: string; emulator: boolean }

/**
 * Parse `flutter devices --machine`.
 *
 * Tolerant on purpose: the command prints warnings above the JSON often enough (a stale tool
 * version, an unrelated toolchain complaint) that parsing the whole of stdout fails on a machine
 * where the devices are perfectly fine. The array is taken from the first `[` instead.
 *
 * Returns [] rather than throwing — a device list that cannot be read is the same as no devices
 * to the caller, and a dropdown is not worth an exception.
 */
export function parseDevices(stdout: string): Device[] {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  let rows: unknown;
  try { rows = JSON.parse(stdout.slice(start)); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const d = r as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id : "";
    if (!id) return [];
    return [{
      id,
      name: typeof d.name === "string" ? d.name : id,
      // targetPlatform is the detailed one (android-arm64); platformType is the family (android).
      platform: typeof d.platformType === "string" ? d.platformType
        : typeof d.targetPlatform === "string" ? d.targetPlatform : "",
      emulator: d.emulator === true,
    }];
  });
}

/** One emulator as `flutter emulators` lists it: an Android AVD, running or not. */
export interface Emulator { id: string; name: string; platform: string }

/**
 * Parse `flutter emulators`. It has no --machine output, so this reads its table, rows of
 * `id • name • manufacturer • platform` under an `Id • Name • …` heading.
 *
 * The bullet arrives as U+FFFD when flutter writes in the console's code page rather than UTF-8,
 * so any short run of punctuation between spaces separates columns. A name holding " - " splits
 * into more columns; the id stays the first and the platform the last, so only the name is cut.
 */
export function parseEmulators(stdout: string): Emulator[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    // Repeated, as an empty column (no manufacturer) is a padded gap between two bullets.
    const cols = line.trim().split(/\s+(?:[^\w\s]{1,3}\s+)+/);
    if (cols.length < 3 || cols[0] === "Id" || /\s/.test(cols[0])) return [];
    return [{ id: cols[0], name: cols[1], platform: cols[cols.length - 1].toLowerCase() }];
  });
}

/**
 * Whether a pubspec.yaml is a Flutter project's rather than a pure Dart package's — both have
 * one, and only the first can be run on a device.
 */
export function isFlutterPubspec(yaml: string): boolean {
  return /^\s*flutter\s*:/m.test(yaml) || /sdk:\s*flutter/m.test(yaml);
}

/**
 * Folders never worth looking inside for another app.
 *
 * Not only for speed. `build/` and the platform folders hold COPIES of plugin pubspecs
 * (ios/.symlinks, the generated plugin registrants), so descending into them would offer
 * every dependency as an app to run.
 */
const SKIP_DIRS = new Set([
  "build", "node_modules", "target", "dist",
  "android", "ios", "macos", "linux", "windows", "Pods",
]);

/** Whether the app search should look inside a folder of this name. Hidden folders never. */
export function shouldDescend(name: string): boolean {
  return !name.startsWith(".") && !SKIP_DIRS.has(name);
}

/** Whether a directory is a folder itself or inside it. An empty folder holds nothing. */
const holds = (folder: string, dir: string) => {
  const c = norm(folder), f = norm(dir);
  return !!c && (f === c || f.startsWith(c + "/"));
};

/**
 * Whether a run in `dir` shows in the active workspace: when that workspace's folder holds it,
 * or when no workspace's folder does.
 *
 * Every workspace holding it shows it, not only the deepest. A folder of several repos is often
 * open beside a workspace on one of them, and an app started from the folder's picker vanished
 * from where it was started because the nested workspace claimed it.
 *
 * Decided by directory rather than by recording the workspace that started a run, because an
 * agent starts runs over MCP with only a directory to go on.
 */
export function runIsHere(
  workspaces: readonly { id: string; cwd: string; folders?: string[] }[], activeWs: string, dir: string,
): boolean {
  // Any of a project's folders (Deck's multi-root projects).
  const holdsIn = (w: { cwd: string; folders?: string[] }) => [w.cwd, ...(w.folders ?? [])].some((f) => holds(f, dir));
  const here = workspaces.find((w) => w.id === activeWs);
  return (!!here && holdsIn(here)) || !workspaces.some(holdsIn);
}

/**
 * What the app scan covers for a project: its folder, or with several (Deck's multi-root projects)
 * all of them joined with "|", the main one first. Only folders on this PC: an app runs here.
 */
export function projectRoot(w: { cwd: string; folders?: string[] } | undefined): string {
  if (!w) return "";
  const local = (w.folders ?? []).filter((f) => f && !/^[A-Za-z0-9._@-]{2,}(\+sudo)?:\//.test(f));
  return [w.cwd, ...local].join("|");
}

/** An app's name in the picker: its path under the workspace, or the folder name at the root. */
export function appLabel(root: string, app: string): string {
  // Several folders ("a|b", projectRoot): under the name of the one holding it.
  if (root.includes("|")) {
    const holder = root.split("|").filter((f) => holds(f, app)).sort((a, b) => b.length - a.length)[0];
    if (!holder) return app;
    const top = holder.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || holder;
    return norm(app) === norm(holder) ? top : `${top}/${appLabel(holder, app)}`;
  }
  const r = norm(root);
  const a = app.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm(a) === r) return a.split("/").pop() || a;
  return norm(a).startsWith(r + "/") ? a.slice(r.length + 1) : a;
}
