// The apps running from here, as rows under their project in Deck's workspace sidebar (its sidebar
// API, beside the project's agents): "Flutter · Pixel 7", and whether it runs. A click opens the
// Flutter panel on its log; a right-click reloads, restarts or stops it.
import { setSidebarRows, type SidebarRow } from "../shim/sidebar.js";
import * as store from "./store.js";

/** Asks the panel (plugin.tsx) to show a run, by id. */
export const SELECT_RUN = "deck-flutter-select-run";

const stateOf = (r: store.Run): SidebarRow["status"] =>
  r.status === "running" ? { text: "running", tone: "ok", dot: true }
  : r.status === "reloading" ? { text: "reloading", tone: "ok", dot: true }
  : r.status === "starting" ? { text: "starting", tone: "muted", dot: true }
  : r.status === "stopping" ? { text: "stopping", tone: "muted" }
  : { text: r.stopRequested ? "stopped" : "ended", tone: r.stopRequested ? "muted" : "bad" };

const openLog = (r: store.Run) => {
  window.dispatchEvent(new CustomEvent(SELECT_RUN, { detail: r.id }));
  window.dispatchEvent(new CustomEvent("deck-footer-tab", { detail: "plugin:flutter" }));
};

// What can be done to it from the sidebar: what the panel's buttons do, while it runs or once it has ended.
const menuOf = (r: store.Run): SidebarRow["menu"] => r.status === "ended"
  ? [{ label: "Open log", onClick: () => openLog(r) }, "sep",
     { label: "Run again", onClick: () => { void store.start(r.cwd, r.deviceId, r.deviceName).then((id) => { if (id) store.dismiss(r.id); }); } },
     { label: "Close", onClick: () => store.dismiss(r.id) }]
  : [{ label: "Open log", onClick: () => openLog(r) }, "sep",
     { label: "Hot reload", onClick: () => void store.reload(r.id), disabled: r.status !== "running" },
     { label: "Hot restart", onClick: () => void store.restart(r.id), disabled: r.status !== "running" }, "sep",
     { label: "Stop", onClick: () => store.stop(r.id), danger: true, disabled: r.status === "stopping" }];

const rowOf = (r: store.Run): SidebarRow => ({
  id: r.id, cwd: r.cwd,
  icon: { text: "F", color: "rgb(var(--tone-sky-300))" },
  label: "Flutter", detail: r.deviceName,
  status: stateOf(r),
  title: `Flutter on ${r.deviceName}${r.sdk?.version ? ` (${r.sdk.version})` : ""}\n${r.cwd}`,
  onClick: () => openLog(r),
  menu: menuOf(r),
});

// A Deck from before the sidebar module has none: the rows are simply not shown there.
const publish = () => { try { setSidebarRows(store.getRuns().map(rowOf)); } catch { /* no sidebar module */ } };
const un = store.subscribe(publish);
publish();

/** Stop publishing, for the plugin's dispose (Deck drops the rows itself on a reload too). */
export function disposeSidebar() { un(); }
