// The run menu's version row: which Flutter an app will run on, and a submenu to pick another for
// this session, pin one with FVM, install one, or use the Flutter on PATH. Resolved each time the
// menu opens; nothing here polls.
import { useEffect, useState } from "react";
import { Layers, Pin, Download, Terminal, BookOpen } from "lucide-react";
import { openExternal } from "../shim/bridge.js";
import { ConfirmDialog, notify, type ConfirmState, type MenuEntry } from "../shim/ui.js";
import {
  FVM_DOCS, PATH_CHOICE, fvmInstalled, install, installedVersions, pathVersion, pickFor, pin, releases, sdkFor, sdkLabel, type Sdk,
} from "./sdk.js";
import type { Releases } from "./fvmpin.js";

const nameOf = (app: string) => app.split(/[\\/]/).filter(Boolean).pop() ?? app;

export function useVersionMenu(open: boolean, apps: string[] | null) {
  const [sdks, setSdks] = useState<Record<string, Sdk>>({});
  /** Whether FVM is installed; null while it is still being asked (its first start takes a second). */
  const [fvmOn, setFvmOn] = useState<boolean | null>(null);
  const [versions, setVersions] = useState<string[] | null>(null);
  const [rel, setRel] = useState<Releases | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  /** The version of the Flutter on PATH, shown beside its row. */
  const [pathVer, setPathVer] = useState<string | null>(null);

  const resolve = (list: string[]) => Promise.all(list.map(async (a) => [a, await sdkFor(a)] as const))
    .then((pairs) => setSdks((m) => ({ ...m, ...Object.fromEntries(pairs) })));

  useEffect(() => {
    if (!open || !apps?.length) return;
    let alive = true;
    void resolve(apps);
    void pathVersion().then((v) => { if (alive) setPathVer(v); });
    void fvmInstalled().then((installed) => {
      if (!alive) return;
      setFvmOn(installed);
      if (!installed) return;
      void installedVersions().then((v) => { if (alive) setVersions(v); });
      void releases().then((r) => { if (alive) setRel(r); });
    });
    return () => { alive = false; };
  }, [open, apps]);

  /** Use a version for this session (or PATH's Flutter), then show the row with it ticked. */
  const choose = (app: string, v: string) => { pickFor(app, v); void resolve([app]); };

  const askPin = (app: string, v: string) => setConfirm({
    title: `Use Flutter ${v} for ${nameOf(app)}?`,
    body: "Pinning writes it to the project's .fvmrc (fvm use), so everyone on the project gets it. The Dart language server picks it up on its next restart.",
    confirmLabel: `Pin ${v}`,
    onConfirm: () => {
      pin(app, v).then(() => {
        void resolve([app]);
        notify({ kind: "activity", source: "Flutter", key: `pin:${app}`, title: `${nameOf(app)} uses Flutter ${v}`, body: "Pinned in .fvmrc." });
      }, (e: unknown) => notify({ kind: "error", source: "Flutter", key: `pin:${app}`, title: `Could not pin Flutter ${v}`, body: String(e instanceof Error ? e.message : e) }));
    },
  });

  /**
   * The row for one app; null where versions mean nothing (no FVM and no pin), and "pending" while
   * its SDK, or whether FVM is installed, is still being found.
   */
  const versionRow = (app: string): MenuEntry | null | "pending" => {
    const sdk = sdks[app];
    if (!sdk) return "pending";
    if (!sdk.pin && !sdk.picked) { if (fvmOn === null) return "pending"; if (!fvmOn) return null; }
    const current = sdk.source === "path" ? PATH_CHOICE : (sdk.picked ? null : sdk.pin) ?? sdk.version;
    const children: MenuEntry[] = [];
    if (fvmOn === null) {
      children.push({ label: "Checking FVM…", disabled: true });
    } else if (fvmOn) {
      if (versions?.length) children.push({ label: "Installed with FVM", disabled: true });
      for (const v of versions ?? []) children.push({
        label: v,
        subLabel: v === sdk.pin ? "pinned" : undefined,
        checked: v === current || (sdk.picked && sdk.source === "fvm" && v === sdk.version),
        onClick: () => choose(app, v),
        action: v === sdk.pin ? undefined : { icon: Pin, title: `Pin ${v} for ${nameOf(app)}`, onClick: () => askPin(app, v) },
      });
      if (versions === null) children.push({ label: "Listing versions…", disabled: true });
      else if (!versions.length) children.push({ label: "No versions installed with FVM", disabled: true });
      children.push("sep", {
        label: "Install another version", icon: Download,
        // Every stable release, a row per minor version opening its patches, then the newest beta.
        children: rel === null ? [{ label: "Loading releases…", disabled: true }]
          : !rel.stable.length ? [{ label: "Could not list releases", disabled: true }]
          : [
            ...rel.stable.map((g): MenuEntry => ({
              label: g.minor, subLabel: `newest ${g.versions[0]}`,
              children: g.versions.map((v) => ({ label: v, onClick: () => { install(v); } })),
            })),
            ...(rel.beta ? ["sep" as const, { label: rel.beta, subLabel: "beta", onClick: () => { install(rel.beta!); } }] : []),
          ],
      });
    } else {
      children.push({ label: "FVM is not installed", disabled: true },
        { label: "How to install FVM", icon: BookOpen, onClick: () => { void openExternal(FVM_DOCS).catch((e) => console.warn("[flutter] could not open the FVM docs", e)); } });
    }
    children.push({ label: "Use Flutter on PATH", hint: pathVer ?? undefined, icon: Terminal, checked: sdk.source === "path", onClick: () => choose(app, PATH_CHOICE) });
    return {
      label: `Flutter ${sdkLabel(sdk)}`,
      subLabel: sdk.missing ? "not installed" : sdk.picked ? "for this session" : sdk.pin ? "pinned in .fvmrc" : undefined,
      icon: Layers,
      children,
    };
  };

  const dialog = <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />;
  return { sdks, versionRow, dialog };
}
