// Which Flutter SDK runs an app: the one its project pins with FVM (fvm.app), one picked for this
// session from the run menu, or the Flutter on PATH, as before FVM support. Resolved when a menu
// opens or a run starts, never on a poll; a run keeps the answer it started with.
//
// FVM itself is only asked where it has to be: once for its cache folder (`fvm api context`), and
// for the actions a person clicks (pin, install, the release list). A machine without FVM, and a
// project without a pin, never start it.
import { exec, fsList, fsRead, fsSize, fsHomeDir, isWindows, openExternal } from "../shim/bridge.js";
import { notify } from "../shim/ui.js";
import { getLayout, openTabInWorkspace, queueInput } from "../shim/terminals.js";
import { PATH_CHOICE, parentsOf, pinFrom, releasesFrom, versionFrom } from "./fvmpin.js";

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
const exists = (p: string) => fsSize(p).then(() => true, () => false);
const key = (dir: string) => dir.replace(/[\\/]+$/, "").toLowerCase();

/** The nearest folder at or above `dir` whose pin file names a version, and that version. */
export async function findPin(dir: string): Promise<{ dir: string; pin: string } | null> {
  for (const d of parentsOf(dir)) {
    const pin = pinFrom(await text(join(d, ".fvmrc")), await text(join(d, ".fvm", "fvm_config.json")));
    if (pin) return { dir: d, pin };
  }
  return null;
}

/** Whether FVM is installed, and its versions folder. Asked once a session. */
let fvmInfo: Promise<{ installed: boolean; versions: string }> | null = null;
export function fvm() {
  fvmInfo ??= exec("fvm", ["api", "context"]).then(async (o) => {
    // Its context also lists the environment, so only the one field is kept and nothing is logged.
    const dir = o.code === 0 ? (JSON.parse(o.stdout) as { context?: { versionsCachePath?: string } }).context?.versionsCachePath : undefined;
    return { installed: o.code === 0, versions: dir || join(await fsHomeDir(), "fvm", "versions") };
  }).catch(async () => ({ installed: false, versions: join(await fsHomeDir(), "fvm", "versions") }));
  return fvmInfo;
}

async function versionIn(root: string) {
  return versionFrom(await text(join(root, "bin", "cache", "flutter.version.json")), await text(join(root, "version")));
}

/** The Flutter on PATH and its version, found once a session. */
let pathInfo: Promise<string | null> | null = null;
function pathVersion() {
  pathInfo ??= exec(isWindows() ? "where" : "which", ["flutter"]).then((o) => {
    const bin = o.stdout.split(/\r?\n/)[0]?.trim();
    // <sdk>/bin/flutter(.bat): the SDK is two levels up.
    return bin ? versionIn(bin.split(/[\\/]/).slice(0, -2).join(sep())) : null;
  }).catch(() => null);
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
    const roots: string[] = [];
    // `fvm use` links the project's .fvm/flutter_sdk to the pinned SDK; a picked version has no link.
    if (found && choice === pin) roots.push(join(found.dir, ".fvm", "flutter_sdk"));
    roots.push(join((await fvm()).versions, choice));
    for (const root of roots) {
      const exe = join(root, "bin", script());
      if (await exists(exe)) return { flutter: exe, version: (await versionIn(root)) ?? choice, source: "fvm", pin, picked: choice !== pin };
    }
    return { flutter: "flutter", version: choice, source: "fvm", pin, missing: true, picked: choice !== pin };
  }
  return { flutter: "flutter", version: await pathVersion(), source: "path", pin, picked: !!pin };
}

/** How an SDK reads on screen: "3.24.0 · FVM", "3.27.1 · PATH". */
export const sdkLabel = (s: Sdk) => `${s.version ?? "Flutter"} · ${s.source === "fvm" ? "FVM" : "PATH"}`;

/** The versions FVM has installed, by folder name. */
export async function installedVersions(): Promise<string[]> {
  const { versions } = await fvm();
  return fsList(versions).then((l) => l.filter((e) => e.dir).map((e) => e.name), () => []);
}

/** The newest releases FVM can install, fetched once a session and only when asked for. */
let releaseList: Promise<{ version: string; channel: string }[]> | null = null;
export function releases() {
  releaseList ??= exec("fvm", ["api", "releases"]).then((o) => releasesFrom(o.stdout), () => []);
  return releaseList;
}

/** Pin a version for the project in `app`: `fvm use`, which writes .fvmrc there. */
export async function pin(app: string, version: string) {
  const o = await exec("fvm", ["use", version, "--skip-pub-get"], app);
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
  const name = app.split(/[\/]/).filter(Boolean).pop() ?? "this app";
  const { installed } = await fvm();
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
