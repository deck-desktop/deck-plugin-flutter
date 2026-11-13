// Which Flutter SDK runs an app: the one its project pins with FVM (fvm.app), one picked for this
// session from the run menu, or the Flutter on PATH, as before FVM support. Resolved when a menu
// opens or a run starts, never on a poll; a run keeps the answer it started with.
//
// FVM itself is only started where it has to be: for its cache folder (`fvm api context`, once,
// when a version is looked up there), the release list (once, when an FVM user opens the menu),
// and the actions a person clicks (pin, install). Whether it is installed is a `where fvm`.
import { exec, fsList, fsRead, fsSize, fsHomeDir, isWindows, openExternal } from "../shim/bridge.js";
import { notify } from "../shim/ui.js";
import { getLayout, openTabInWorkspace, queueInput } from "../shim/terminals.js";
import { PATH_CHOICE, parentsOf, pinFrom, releasesFrom, versionFrom, type Releases } from "./fvmpin.js";

export { PATH_CHOICE };

export interface Sdk {
  /** What runs: the SDK's flutter script, or "flutter" for the one on PATH. */
  flutter: string;
  /** Its version as the SDK reports it ("3.24.0"), or what the pin names when not installed. */
  version: string | null;
  /** "fvm" for a pinned or picked FVM version, "path" for the Flutter on PATH. */
  source: "fvm" | "path";
  /** What the project pins, as written in .fvmrc; null without a pin. */
  pin: string | null;
  /** The pinned or picked version is not installed, so nothing can run on it yet. */
  missing?: boolean;
  /** Picked from the run menu for this session rather than pinned. */
  picked?: boolean;
}

const sep = () => (isWindows() ? "\\" : "/");
const join = (...p: string[]) => p.join(sep());
const script = () => (isWindows() ? "flutter.bat" : "flutter");
const text = (p: string) => fsRead(p).then((t) => t, () => undefined); // a missing file is normal here
// fsSize answers 0 for a missing file rather than failing; a flutter script is never empty.
const exists = (p: string) => fsSize(p).then((n) => n > 0, () => false);
const key = (dir: string) => dir.replace(/[\\/]+$/, "").toLowerCase();

/** The nearest folder at or above `dir` whose pin file names a version, and that version. */
export async function findPin(dir: string): Promise<{ dir: string; pin: string } | null> {
  for (const d of parentsOf(dir)) {
    const pin = pinFrom(await text(join(d, ".fvmrc")), await text(join(d, ".fvm", "fvm_config.json")));
    if (pin) return { dir: d, pin };
  }
  return null;
}

/** Whether FVM is installed: on PATH, found without starting it. Asked once a session. */
let fvmOn: Promise<boolean> | null = null;
export function fvmInstalled() {
  fvmOn ??= exec(isWindows() ? "where" : "which", ["fvm"]).then((o) => o.code === 0 && !!o.stdout.trim(), () => false);
  return fvmOn;
}

/**
 * FVM's versions folder. Asks FVM (`fvm api context`) once, and only when a version has to be found
 * in its cache; without FVM, its default `~/fvm/versions`.
 */
let cacheDir: Promise<string> | null = null;
export function versionsDir() {
  cacheDir ??= (async () => {
    const fallback = join(await fsHomeDir(), "fvm", "versions");
    if (!(await fvmInstalled())) return fallback;
    const o = await exec("fvm", ["api", "context"]).catch((e) => { console.warn("[flutter] fvm api context failed", e); return null; });
    if (!o || o.code !== 0) return fallback;
    // Its context also lists the environment, so only the one field is kept and nothing of the
    // output is logged. Anything printed around the JSON (an update notice) is skipped.
    try {
      const json = o.stdout.slice(o.stdout.indexOf("{"), o.stdout.lastIndexOf("}") + 1);
      return (JSON.parse(json) as { context?: { versionsCachePath?: string } }).context?.versionsCachePath || fallback;
    } catch {
      console.warn("[flutter] fvm api context did not print its JSON; using ~/fvm/versions");
      return fallback;
    }
  })();
  return cacheDir;
}

async function versionIn(root: string) {
  return versionFrom(await text(join(root, "bin", "cache", "flutter.version.json")), await text(join(root, "version")));
}

/** The Flutter on PATH and its version, found once a session; asked again while it has no answer. */
let pathInfo: Promise<string | null> | null = null;
export function pathVersion() {
  pathInfo ??= exec(isWindows() ? "where" : "which", ["flutter"]).then((o) => {
    const bin = o.stdout.split(/\r?\n/)[0]?.trim();
    // <sdk>/bin/flutter(.bat): the SDK is two levels up.
    return bin ? versionIn(bin.split(/[\\/]/).slice(0, -2).join(sep())) : null;
  }).catch((e) => { console.warn("[flutter] could not find the Flutter on PATH", e); return null; })
    .then((v) => { if (!v) pathInfo = null; return v; });
  return pathInfo;
}

/** Versions picked from the run menu, by app folder, for this session. */
const picked = new Map<string, string>();
export function pickFor(app: string, version: string | null) {
  if (version) picked.set(key(app), version); else picked.delete(key(app));
}

/** The SDK an app in `app` runs on now. */
export async function sdkFor(app: string): Promise<Sdk> {
  const found = await findPin(app);
  const pin = found?.pin ?? null;
  const choice = picked.get(key(app)) ?? pin;
  if (choice && choice !== PATH_CHOICE) {
    // `fvm use` links the project's .fvm/flutter_sdk to the pinned SDK and writes the version beside
    // it (.fvm/release: the pin as written). A link whose release is not the pin is stale (the pin changed in a pull,
    // without an `fvm use`), so the cache is used instead. A picked version has no link.
    // FVM itself is asked for its cache only after that, since its first start can take seconds.
    const fvmDir = found ? join(found.dir, ".fvm") : "";
    const link = found && choice === pin && (await text(join(fvmDir, "release")))?.trim() === pin ? join(fvmDir, "flutter_sdk") : null;
    for (const root of [link, async () => join(await versionsDir(), choice)]) {
      if (!root) continue;
      const dir = typeof root === "string" ? root : await root();
      const exe = join(dir, "bin", script());
      if (await exists(exe)) return { flutter: exe, version: (await versionIn(dir)) ?? choice, source: "fvm", pin, picked: choice !== pin };
    }
    return { flutter: "flutter", version: choice, source: "fvm", pin, missing: true, picked: choice !== pin };
  }
  return { flutter: "flutter", version: await pathVersion(), source: "path", pin, picked: !!pin };
}

/** How an SDK reads on screen: "3.24.0 · FVM", "3.27.1 · PATH". */
export const sdkLabel = (s: Sdk) => `${s.version ?? "Flutter"} · ${s.source === "fvm" ? "FVM" : "PATH"}`;

/** The versions FVM has installed, by folder name. */
export async function installedVersions(): Promise<string[]> {
  const versions = await versionsDir();
  // Not filtered on `dir`: a version can be a link (a custom SDK, `fvm fork`), which lists as a file.
  return fsList(versions).then((l) => l.filter((e) => !e.name.startsWith(".")).map((e) => e.name), () => []);
}

/** The newest releases FVM can install, fetched once a session and only when asked for. */
let releaseList: Promise<Releases> | null = null;
export function releases() {
  releaseList ??= exec("fvm", ["api", "releases"]).then((o) => releasesFrom(o.stdout), () => ({ stable: [], beta: null }));
  return releaseList;
}

/**
 * Pin a version for the project in `app`: `fvm use`, which writes .fvmrc there. Given a minute: FVM
 * holds a lock while another of its commands runs, so a `fvm use` behind an install that waits on a
 * prompt waits too, and would otherwise say nothing at all.
 */
export async function pin(app: string, version: string) {
  // ponytail: the timed-out `fvm use` is left running until FVM's lock frees or Deck exits.
  const late = new Promise<never>((_, fail) => setTimeout(() => fail(new Error(
    `fvm use did not finish within a minute. Another FVM command may be waiting (an install in a terminal); run "fvm use ${version}" in the project to see why.`)), 60_000));
  const o = await Promise.race([exec("fvm", ["use", version, "--skip-pub-get"], app), late]);
  if (o.code !== 0) throw new Error((o.stderr || o.stdout).trim().split(/\r?\n/).pop() || `fvm use exited with ${o.code}`);
  pickFor(app, null);
}

/** Install a version in a terminal tab of the active workspace, so the download shows. */
export function install(version: string): boolean {
  const ws = getLayout()?.activeWs;
  const pane = ws ? openTabInWorkspace(ws, `fvm install ${version}`) : null;
  if (!pane) return false;
  queueInput(pane, `fvm install ${version}\r`);
  return true;
}

/** Where FVM's own page says how to install it, for a machine without it. */
export const FVM_DOCS = "https://fvm.app/documentation/getting-started/installation";

/**
 * Say that an app's pinned (or picked) version is not installed, with what can be done: install it
 * with FVM (or read how to get FVM), or run once on the Flutter on PATH. `retry` starts the run.
 */
export async function askToInstall(app: string, sdk: Sdk, retry: () => void) {
  const name = app.split(/[\\/]/).filter(Boolean).pop() ?? "this app";
  const installed = await fvmInstalled();
  const onPath = await pathVersion();
  const actions: { label: string; primary?: boolean; run: () => void }[] = [];
  if (installed) actions.push({ label: "Install with FVM", primary: true, run: () => { install(sdk.version ?? ""); } });
  else actions.push({ label: "How to install FVM", primary: true, run: () => { void openExternal(FVM_DOCS).catch((e) => console.warn("[flutter] could not open the FVM docs", e)); } });
  if (onPath) actions.push({ label: `Run with ${onPath}`, run: () => { pickFor(app, PATH_CHOICE); retry(); } });
  notify({
    kind: "error", source: "Flutter", key: `sdk:${key(app)}`, sticky: true,
    title: `Flutter ${sdk.version} is not installed`,
    body: `${name} ${sdk.picked ? "was set to it" : "pins it in .fvmrc"}. ${installed ? "Install it with FVM, then run again." : "FVM, which installs it, is not on this PC."}`,
    actions,
  });
}
