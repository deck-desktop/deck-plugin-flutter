// The pure half of FVM support: what a project's pin file says, and how an SDK is named on screen.
// Kept apart from sdk.ts, which reads the disk, so flutter.check.mjs can test it without Deck.

/** "Run on the Flutter on PATH", as a choice beside the installed versions. */
export const PATH_CHOICE = "path";

/**
 * The version (or channel, or `custom_` name) a project pins: `.fvmrc`'s `flutter` (FVM 3 and
 * later), else FVM 2's `.fvm/fvm_config.json` `flutterSdkVersion`. Null when neither says.
 */
export function pinFrom(fvmrc?: string, legacy?: string): string | null {
  const read = (text: string | undefined, key: string) => {
    if (!text) return null;
    try {
      const v = (JSON.parse(text) as Record<string, unknown>)[key];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    } catch { return null; }
  };
  return read(fvmrc, "flutter") ?? read(legacy, "flutterSdkVersion");
}

/** An SDK's own version, from bin/cache/flutter.version.json (or the older root `version` file). */
export function versionFrom(versionJson?: string, versionFile?: string): string | null {
  if (versionJson) {
    try {
      const v = (JSON.parse(versionJson) as { frameworkVersion?: unknown }).frameworkVersion;
      if (typeof v === "string" && v) return v;
    } catch { /* fall through to the older file */ }
  }
  return versionFile?.trim() || null;
}

/** The parent folders of a path, itself first: where a pin file may be. */
export function parentsOf(dir: string): string[] {
  const sep = dir.includes("\\") ? "\\" : "/";
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  const out: string[] = [];
  for (let n = parts.length; n > 0; n--) {
    const p = parts.slice(0, n).join(sep);
    out.push(p === "" ? sep : /^[A-Za-z]:$/.test(p) ? p + sep : p);
  }
  return out;
}

export interface Releases {
  /** Every stable release, by minor version ("3.47"), newest minor and newest patch first. */
  stable: { minor: string; versions: string[] }[];
  /** The newest beta, if any. */
  beta: string | null;
}

/** What FVM can install, from `fvm api releases` (which lists newest first). */
export function releasesFrom(json: string): Releases {
  let list: { version?: unknown; channel?: unknown }[] = [];
  try { list = (JSON.parse(json) as { versions?: typeof list }).versions ?? []; } catch { return { stable: [], beta: null }; }
  const ok = list.filter((r): r is { version: string; channel: string } => typeof r.version === "string" && typeof r.channel === "string");
  const stable: Releases["stable"] = [];
  for (const r of ok) {
    if (r.channel !== "stable") continue;
    const minor = r.version.split(".").slice(0, 2).join(".");
    const group = stable.find((g) => g.minor === minor);
    if (group) group.versions.push(r.version); else stable.push({ minor, versions: [r.version] });
  }
  return { stable, beta: ok.find((r) => r.channel === "beta")?.version ?? null };
}
