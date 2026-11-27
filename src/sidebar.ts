// The apps running from here, as rows under their project in Deck's workspace sidebar (its sidebar
// API, beside the project's agents): "Flutter · Pixel 7", and whether it runs. A click opens the
// Flutter panel on its log.
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

const rowOf = (r: store.Run): SidebarRow => ({
  id: r.id, cwd: r.cwd,
  icon: { text: "F", color: "rgb(var(--tone-sky-300))" },
  label: "Flutter", detail: r.deviceName,
  status: stateOf(r),
  title: `Flutter on ${r.deviceName}${r.sdk?.version ? ` (${r.sdk.version})` : ""}\n${r.cwd}`,
  onClick: () => {
    window.dispatchEvent(new CustomEvent(SELECT_RUN, { detail: r.id }));
    window.dispatchEvent(new CustomEvent("deck-footer-tab", { detail: "plugin:flutter" }));
  },
});

// A Deck from before the sidebar module has none: the rows are simply not shown there.
const publish = () => { try { setSidebarRows(store.getRuns().map(rowOf)); } catch { /* no sidebar module */ } };
const un = store.subscribe(publish);
publish();

/** Stop publishing, for the plugin's dispose (Deck drops the rows itself on a reload too). */
export function disposeSidebar() { un(); }
