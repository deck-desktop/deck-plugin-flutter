// The run button's menu: pick an app in the workspace and a device to run it on.
import { useEffect, useRef, useState } from "react";
import { Smartphone, Monitor, Globe } from "lucide-react";
import { exec, type ExecOut } from "../shim/bridge.js";
import { parseDevices, appLabel, type Device, type Emulator } from "./detect.js";
import { ContextMenu, type MenuEntry } from "../shim/ui.js";
import { scanApps } from "./apps.js";
import { listEmulators, offline, startEmulator } from "./emulators.js";
import { sdkFor } from "./sdk.js";
import { useVersionMenu } from "./useVersionMenu.js";

const ICONS: Record<string, typeof Monitor> = {
  windows: Monitor, macos: Monitor, linux: Monitor,
  web: Globe, android: Smartphone, ios: Smartphone,
};
export const deviceIcon = (platform: string) => ICONS[platform.split("-")[0]] ?? Smartphone;

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
export function DevicePicker({ root, onPick, children }: {
  root: string;
  onPick: (app: string, d: Device) => void;
  children: React.ReactNode;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [apps, setApps] = useState<string[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [emulators, setEmulators] = useState<Emulator[]>([]);
  const anchor = useRef<HTMLButtonElement>(null);
  const open = at !== null;
  const { versionRow, dialog } = useVersionMenu(open, apps);

  // All fetched when the menu opens, never on a poll: `flutter devices` probes adb and the
  // browsers and takes several seconds, which is fine once on a click and not fine every 10s.
  // The emulators are listed alongside, and the running ones left out once the devices are in.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setApps(null);
    setDevices(null);
    setEmulators([]);
    void scanApps(root).then(async (a) => {
      if (!alive) return;
      setApps(a);
      // Listed by the first app's Flutter: a project with only an FVM SDK may have none on PATH.
      const dir = a[0] ?? root.split("|")[0];
      const sdk = await sdkFor(dir);
      const flutter = sdk.missing ? "flutter" : sdk.flutter;
      const all = listEmulators(dir, flutter);
      exec(flutter, ["devices", "--machine"], dir)
        .then((r: ExecOut) => parseDevices(r.stdout), () => [])
        .then((ds) => {
          if (!alive) return;
          setDevices(ds);
          void all.then((e) => offline(e, ds)).then((e) => { if (alive) setEmulators(e); });
        });
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
    const on: MenuEntry[] = devices.map((d) => ({
      label: d.name,
      subLabel: d.emulator ? "emulator" : undefined,
      icon: deviceIcon(d.platform),
      onClick: () => { setAt(null); onPick(app, d); },
    }));
    // An emulator that is off is started first, and the app runs on it once it has booted.
    const off: MenuEntry[] = emulators.map((e) => ({
      label: e.name,
      subLabel: "emulator, off: starts it",
      icon: deviceIcon(e.platform),
      onClick: () => {
        setAt(null);
        void sdkFor(app).then((s) => startEmulator(e, devices, app, s.missing ? "flutter" : s.flutter)).then((d) => { if (d) onPick(app, d); });
      },
    }));
    if (!on.length && !off.length) return [{ label: "No devices found", disabled: true }];
    return on.length && off.length ? [...on, "sep", ...off] : [...on, ...off];
  };

  // Which Flutter it runs on, where FVM is in play (useVersionMenu), below the devices. Nothing
  // shows until the devices and the version have both answered, so the menu fills in one go, and
  // the version row is not under the cursor to open its submenu as the menu appears.
  const withVersion = (app: string): MenuEntry[] => {
    const row = versionRow(app);
    if (devices === null || row === "pending") return [{ label: "Finding devices…", disabled: true }];
    return row ? [...deviceItems(app), "sep", row] : deviceItems(app);
  };

  const items: MenuEntry[] =
    apps === null ? [{ label: "Looking for apps…", disabled: true }]
    : !apps.length ? [{ label: "No Flutter app in this workspace", disabled: true }]
    : apps.length === 1 ? withVersion(apps[0])
    : apps.map((a) => ({ label: appLabel(root, a), icon: Smartphone, children: withVersion(a) }));

  return (
    <>
      <button ref={anchor} onClick={toggle} onMouseDown={(e) => e.stopPropagation()}
        title="Run a Flutter app">{children}</button>
      {at && <ContextMenu x={at.x} y={at.y} alignRight items={items} onClose={() => setAt(null)} />}
      {dialog}
    </>
  );
}
