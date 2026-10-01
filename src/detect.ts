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
  if (p.name.toLowerCase() !== "dart.exe") return false;
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
