// The Flutter apps in a workspace's folder, found by walking it (see scanApps).
import { fsList, fsRead } from "../shim/bridge.js";
import { getLayout } from "../shim/terminals.js";
import { isFlutterPubspec, shouldDescend } from "./detect.js";

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
export const appsCache = new Map<string, string[]>();
const MAX_DEPTH = 3;
const MAX_DIRS = 400;

/** The active workspace's directory, read straight from the layout store. */
export function currentCwd(): string {
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

export async function scanApps(root: string): Promise<string[]> {
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
export const appsIn = (root: string) => {
  const seen = appsCache.get(root);
  return seen ? Promise.resolve(seen) : scanApps(root);
};
