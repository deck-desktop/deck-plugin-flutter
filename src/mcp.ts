// The agent-facing tools for running a Flutter app through Deck.
//
// There are two kinds of run and these tools cover both, because from the outside they are the
// same question:
//
//   plugin — started here (or from Deck's footer). Deck owns the process, speaks the daemon
//            protocol over its stdin, and holds the log. Reload is a JSON command.
//   pane   — a `flutter run` someone typed in a terminal. Reload is the keystroke `r`, because
//            that is all a terminal run can take.
//
// `flutter_list` returns both with a `kind`, and every other tool dispatches on it, so a caller
// never has to know which sort of run it is holding.
//
// The split of responsibilities: reads come from files the frontend publishes
// (plugin-flutter-runs for plugin runs, term-procs for pane runs), writes go through Deck's HTTP
// API. Nothing here reaches into the webview directly, because nothing can.
import { parseDevices, isFlutterRun, type PaneProcs } from "./detect.js";
import type { DeckMcp, McpServer } from "../shim/mcp.js";

/** One log line as the plugin publishes it. */
interface StateLine { ts: number; kind: string; logger: string; text: string }
/** One plugin-owned run. */
interface StateRun {
  id: string; cwd: string; deviceId: string; deviceName: string;
  status: string; appId: string; log: StateLine[];
}
interface State { runs: StateRun[] }

/** A run of either kind, flattened to what a caller acts on. */
interface AnyRun {
  kind: "plugin" | "pane";
  /** The handle for every other tool: a run id for a plugin run, a pane id for a pane run. */
  id: string;
  cwd: string;
  device: string;
  status: string;
}

export function register(server: McpServer, deck: DeckMcp) {
  const { z, ok, readJson, deckApi, apiErr } = deck;

  /** Plugin-owned runs, as the webview last published them. */
  const pluginRuns = (): StateRun[] => readJson<State>("plugin-flutter-runs", { runs: [] }).runs ?? [];

  /**
   * Pane-owned runs, recognised from Deck's process sweep with the same matcher the UI uses.
   *
   * Imported from detect.ts rather than re-implemented: a second copy of "is this a flutter run"
   * would drift from the one the plugin acts on, and the two disagreeing is exactly the bug that
   * makes a reload go to the wrong place.
   */
  async function paneRuns(): Promise<AnyRun[]> {
    const procs = readJson<PaneProcs>("term-procs", {});
    const ids = Object.entries(procs).filter(([, rows]) => rows.some(isFlutterRun)).map(([id]) => id);
    if (!ids.length) return [];
    // The pane list carries the cwd and label, which term-procs does not.
    let panes: { id: string; cwd?: string; label?: string; workspace?: string }[] = [];
    try {
      const r = await deckApi("/dt/list");
      if (r.ok) panes = await r.json();
    } catch { /* Deck unreachable; the ids are still real, just unlabelled */ }
    return ids.map((id) => {
      const p = panes.find((x) => x.id === id);
      return {
        kind: "pane" as const,
        id,
        cwd: p?.cwd ?? "",
        device: p?.label || p?.workspace || "terminal pane",
        status: "running",
      };
    });
  }

  /** Every run, both kinds. Plugin runs first: they are the ones with a real log. */
  async function allRuns(): Promise<AnyRun[]> {
    const mine = pluginRuns().map((r) => ({
      kind: "plugin" as const,
      id: r.id, cwd: r.cwd, device: r.deviceName || r.deviceId, status: r.status,
    }));
    return [...mine, ...(await paneRuns())];
  }

  /**
   * Resolve what the caller meant.
   *
   * An omitted id means "the only live run", which is the usual case — asking an agent to look up
   * an id before every reload is friction for nothing. Ambiguity is an error rather than a guess:
   * reloading the wrong app is silent and confusing.
   */
  async function resolve(id?: string): Promise<AnyRun | string> {
    const runs = (await allRuns()).filter((r) => r.status !== "ended");
    if (id) {
      const hit = runs.find((r) => r.id === id);
      return hit ?? `No live run with id ${id}. Use flutter_list to see what is running.`;
    }
    if (!runs.length) return "No Flutter app is running. Start one with flutter_run.";
    if (runs.length > 1) {
      return "Several apps are running — pass an id:\n" +
        runs.map((r) => `  ${r.id}  ${r.device}  (${r.cwd})`).join("\n");
    }
    return runs[0];
  }

  /** Send a command to the plugin, through Deck's HTTP API. */
  const command = (op: string, args: Record<string, unknown>) =>
    deckApi("/dt/plugin", {
      method: "POST",
      body: JSON.stringify({ plugin: "flutter", op, args }),
    });

  server.tool(
    "flutter_list",
    "List running Flutter apps — both those Deck is running itself and plain `flutter run` " +
      "commands typed in a terminal pane. Also lists the devices available to launch on.",
    { cwd: z.string().optional().describe("project directory, to list its devices") },
    async ({ cwd }) => {
      const runs = await allRuns();
      const lines = runs.length
        ? runs.map((r) => `${r.kind === "plugin" ? "[deck]" : "[pane]"} ${r.id}  ${r.device}  ${r.status}  ${r.cwd}`)
        : ["(nothing running)"];
      if (!cwd) return ok(lines.join("\n"));
      // Devices are a separate question, and a slow one — only asked when a cwd is given.
      try {
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync("flutter", ["devices", "--machine"], {
          cwd, encoding: "utf8", shell: true, timeout: 60_000,
        });
        const devices = parseDevices(out);
        return ok([
          ...lines, "", "Devices:",
          ...(devices.length ? devices.map((d) => `  ${d.id}  ${d.name}${d.emulator ? "  (emulator)" : ""}`)
            : ["  (none found)"]),
        ].join("\n"));
      } catch (e) {
        return ok([...lines, "", `Could not list devices: ${e instanceof Error ? e.message : String(e)}`].join("\n"));
      }
    },
  );

  server.tool(
    "flutter_run",
    "Start a Flutter app on a device, with Deck owning the process — its log (including " +
      "developer.log output) is readable with flutter_log and it reloads without a terminal.",
    {
      cwd: z.string().describe("the Flutter project directory (the one holding pubspec.yaml)"),
      deviceId: z.string().describe("device id from flutter_list, e.g. windows, chrome, or a phone's serial"),
    },
    async ({ cwd, deviceId }) => {
      try {
        const r = await command("start", { cwd, deviceId, deviceName: deviceId });
        if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
        return ok(
          `Starting ${deviceId} in ${cwd}.\n` +
          "The build takes a while — read flutter_log in a few seconds to see progress, and " +
          "wait for 'app started' before sending a reload.",
        );
      } catch (e) { return apiErr(e); }
    },
  );

  for (const [name, op, what] of [
    ["flutter_reload", "reload", "Hot reload — keeps app state. The default after an edit."],
    ["flutter_restart", "restart", "Hot restart — rebuilds the app and LOSES state. For main(), provider wiring, enum/const/static initializers."],
  ] as const) {
    server.tool(
      name, what,
      { id: z.string().optional().describe("run id from flutter_list; omit when only one app is running") },
      async ({ id }) => {
        const run = await resolve(id);
        if (typeof run === "string") return ok(run);
        try {
          if (run.kind === "pane") {
            // A terminal run takes a keystroke, not a protocol. Capital R is a hot restart.
            const key = op === "reload" ? "r" : "R";
            const r = await deckApi("/dt/keys", {
              method: "POST", body: JSON.stringify({ id: run.id, keys: [key] }),
            });
            if (!r.ok) return ok(`Deck refused the keystroke: ${r.status} ${await r.text()}`);
            return ok(`Sent '${key}' to the pane running ${run.device}. Read it with deck_term_read.`);
          }
          const r = await command(op, { id: run.id });
          if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
          return ok(`${op === "reload" ? "Reloading" : "Restarting"} ${run.device}. Check flutter_log for the result.`);
        } catch (e) { return apiErr(e); }
      },
    );
  }

  server.tool(
    "flutter_stop",
    "Stop a running Flutter app.",
    { id: z.string().optional().describe("run id from flutter_list; omit when only one app is running") },
    async ({ id }) => {
      const run = await resolve(id);
      if (typeof run === "string") return ok(run);
      try {
        if (run.kind === "pane") {
          const r = await deckApi("/dt/keys", {
            method: "POST", body: JSON.stringify({ id: run.id, keys: ["q"] }),
          });
          if (!r.ok) return ok(`Deck refused the keystroke: ${r.status} ${await r.text()}`);
          return ok(`Sent 'q' to the pane running ${run.device}.`);
        }
        const r = await command("stop", { id: run.id });
        if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
        return ok(`Stopping ${run.device}.`);
      } catch (e) { return apiErr(e); }
    },
  );

  server.tool(
    "flutter_log",
    "Read a Deck-run app's output — build progress, print/debugPrint, and developer.log lines " +
      "that a plain `flutter run` never shows. Only for [deck] runs; use deck_term_read for a pane.",
    {
      id: z.string().optional().describe("run id from flutter_list; omit when only one app is running"),
      lines: z.number().int().positive().max(200).default(40),
      filter: z.string().optional().describe("only lines containing this text (case-insensitive)"),
    },
    async ({ id, lines, filter }) => {
      const runs = pluginRuns();
      if (!runs.length) {
        return ok("No Deck-run app. A `flutter run` in a terminal pane is read with deck_term_read instead.");
      }
      const run = id ? runs.find((r) => r.id === id) : runs.length === 1 ? runs[0] : undefined;
      if (!run) {
        return ok("Several runs — pass an id:\n" + runs.map((r) => `  ${r.id}  ${r.deviceName}`).join("\n"));
      }
      const needle = filter?.toLowerCase();
      const picked = (needle ? run.log.filter((l) => l.text.toLowerCase().includes(needle)) : run.log)
        .slice(-lines);
      const when = (ts: number) => new Date(ts).toISOString().slice(11, 19);
      return ok(
        `${run.deviceName} — ${run.status}\n\n` +
        (picked.length
          ? picked.map((l) => `${when(l.ts)} ${l.logger ? `[${l.logger}] ` : ""}${l.text}`).join("\n")
          : "(no output yet)"),
      );
    },
  );
}
