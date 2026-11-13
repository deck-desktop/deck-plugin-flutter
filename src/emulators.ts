// Emulators that are off: listed in the run menu below the devices, and started from it.
//
// `flutter emulators` lists every AVD, and `flutter emulators --launch` starts one. Neither says
// which are running, nor waits until the one started can take an app, so both are done here.
import { exec } from "../shim/bridge.js";
import { notify, dismissNotification } from "../shim/ui.js";
import { parseDevices, parseEmulators, type Device, type Emulator } from "./detect.js";

/** Every emulator `flutter emulators` knows, running or not; none when the command fails. */
export const listEmulators = (cwd: string, flutter = "flutter"): Promise<Emulator[]> =>
  exec(flutter, ["emulators"], cwd).then((r) => parseEmulators(r.stdout), () => []);

/** The AVD a running emulator was started from (adb answers "Pixel_7\nOK"), or "" without adb. */
const avdOf = (serial: string) =>
  exec("adb", ["-s", serial, "emu", "avd", "name"]).then((r) => r.stdout.split(/\r?\n/)[0].trim(), () => "");

/**
 * The emulators that are not running. A running emulator's device name is its system image's
 * ("sdk gphone64 x86 64"), not its AVD's, so each one is asked its AVD over adb. Without adb on
 * PATH none can be matched and all are listed; starting one already running then fails with the
 * emulator's own message.
 */
export async function offline(all: Emulator[], running: Device[]): Promise<Emulator[]> {
  const on = await Promise.all(running.filter((d) => d.emulator && d.id.startsWith("emulator-")).map((d) => avdOf(d.id)));
  return all.filter((e) => !on.includes(e.id));
}

/** Whether Android in the emulator has finished booting, so an install will not fail. Without
 *  adb this cannot be asked, and it is taken as booted. */
const booted = (serial: string) =>
  exec("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"]).then((r) => r.stdout.trim() === "1", () => true);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A cold boot of a big image on a slow disk. */
const BOOT_MS = 240_000;

/**
 * Start an emulator and wait until it can take an app: it shows in `flutter devices` as an
 * emulator that was not there before, and has finished booting. Resolves to that device named
 * after the emulator, or to null with a notification saying why.
 */
export async function startEmulator(emu: Emulator, before: Device[], cwd: string, flutter = "flutter"): Promise<Device | null> {
  const key = `emulator:${emu.id}`;
  notify({ source: "Flutter", key, transient: true, sticky: true, title: "Starting the emulator…", body: emu.name });
  let failed = "";
  // Not awaited: flutter returns three seconds after starting the emulator, and the wait below is
  // what matters. An emulator that quits in those seconds (an AVD already running, no
  // acceleration), or an id that matches none, is reported in its output with exit code 0.
  exec(flutter, ["emulators", "--launch", emu.id], cwd)
    .then((r) => {
      const said = `${r.stderr}\n${r.stdout}`.trim();
      if (r.code !== 0 || /exited with code|No emulator found|More than one emulator/.test(said)) failed = said || `exit code ${r.code}`;
    })
    .catch((e) => { failed = String(e); });

  const known = new Set(before.map((d) => d.id));
  let device: Device | undefined;
  for (const end = Date.now() + BOOT_MS; !failed && Date.now() < end; await sleep(2000)) {
    device ??= await exec(flutter, ["devices", "--machine"], cwd)
      .then((r) => parseDevices(r.stdout).find((d) => d.emulator && !known.has(d.id)), () => undefined);
    if (device && await booted(device.id)) {
      dismissNotification("Flutter", key);
      return { ...device, name: emu.name };
    }
  }
  dismissNotification("Flutter", key);
  console.warn("[flutter] emulator did not start", emu.id, failed);
  notify({ source: "Flutter", key, sticky: true, title: "The emulator did not start",
    body: failed || `${emu.name} was not ready after ${BOOT_MS / 60_000} minutes.` });
  return null;
}
