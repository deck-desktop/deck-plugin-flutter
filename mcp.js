// plugins/flutter/src/detect.ts
function isFlutterRun(p) {
  if (p.name.toLowerCase() !== "dart.exe") return false;
  const c = p.cmd.toLowerCase();
  return c.includes("flutter_tools.snapshot") && c.split(/\s+/).some((w) => w === "run");
}
function parseDevices(stdout) {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  let rows;
  try {
    rows = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const d = r;
    const id = typeof d.id === "string" ? d.id : "";
    if (!id) return [];
    return [{
      id,
      name: typeof d.name === "string" ? d.name : id,
      // targetPlatform is the detailed one (android-arm64); platformType is the family (android).
      platform: typeof d.platformType === "string" ? d.platformType : typeof d.targetPlatform === "string" ? d.targetPlatform : "",
      emulator: d.emulator === true
    }];
  });
}

// plugins/flutter/src/mcp.ts
function register(server, deck) {
  const { z, ok, readJson, deckApi, apiErr } = deck;
  const pluginRuns = () => readJson("plugin-flutter-runs", { runs: [] }).runs ?? [];
  async function paneRuns() {
    const procs = readJson("term-procs", {});
    const ids = Object.entries(procs).filter(([, rows]) => rows.some(isFlutterRun)).map(([id]) => id);
    if (!ids.length) return [];
    let panes = [];
    try {
      const r = await deckApi("/dt/list");
      if (r.ok) panes = await r.json();
    } catch {
    }
    return ids.map((id) => {
      const p = panes.find((x) => x.id === id);
      return {
        kind: "pane",
        id,
        cwd: p?.cwd ?? "",
        device: p?.label || p?.workspace || "terminal pane",
        status: "running"
      };
    });
  }
  async function allRuns() {
    const mine = pluginRuns().map((r) => ({
      kind: "plugin",
      id: r.id,
      cwd: r.cwd,
      device: r.deviceName || r.deviceId,
      status: r.status
    }));
    return [...mine, ...await paneRuns()];
  }
  async function resolve(id) {
    const runs = (await allRuns()).filter((r) => r.status !== "ended");
    if (id) {
      const hit = runs.find((r) => r.id === id);
      return hit ?? `No live run with id ${id}. Use flutter_list to see what is running.`;
    }
    if (!runs.length) return "No Flutter app is running. Start one with flutter_run.";
    if (runs.length > 1) {
      return "Several apps are running \u2014 pass an id:\n" + runs.map((r) => `  ${r.id}  ${r.device}  (${r.cwd})`).join("\n");
    }
    return runs[0];
  }
  const command = (op, args) => deckApi("/dt/plugin", {
    method: "POST",
    body: JSON.stringify({ plugin: "flutter", op, args })
  });
  server.tool(
    "flutter_list",
    "List running Flutter apps \u2014 both those Deck is running itself and plain `flutter run` commands typed in a terminal pane. Also lists the devices available to launch on.",
    { cwd: z.string().optional().describe("project directory, to list its devices") },
    async ({ cwd }) => {
      const runs = await allRuns();
      const lines = runs.length ? runs.map((r) => `${r.kind === "plugin" ? "[deck]" : "[pane]"} ${r.id}  ${r.device}  ${r.status}  ${r.cwd}`) : ["(nothing running)"];
      if (!cwd) return ok(lines.join("\n"));
      try {
        const { execFileSync } = await import("node:child_process");
        const out = execFileSync("flutter", ["devices", "--machine"], {
          cwd,
          encoding: "utf8",
          shell: true,
          timeout: 6e4
        });
        const devices = parseDevices(out);
        return ok([
          ...lines,
          "",
          "Devices:",
          ...devices.length ? devices.map((d) => `  ${d.id}  ${d.name}${d.emulator ? "  (emulator)" : ""}`) : ["  (none found)"]
        ].join("\n"));
      } catch (e) {
        return ok([...lines, "", `Could not list devices: ${e instanceof Error ? e.message : String(e)}`].join("\n"));
      }
    }
  );
  server.tool(
    "flutter_run",
    "Start a Flutter app on a device, with Deck owning the process \u2014 its log (including developer.log output) is readable with flutter_log and it reloads without a terminal.",
    {
      cwd: z.string().describe("the Flutter project directory (the one holding pubspec.yaml)"),
      deviceId: z.string().describe("device id from flutter_list, e.g. windows, chrome, or a phone's serial")
    },
    async ({ cwd, deviceId }) => {
      try {
        const r = await command("start", { cwd, deviceId, deviceName: deviceId });
        if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
        return ok(
          `Starting ${deviceId} in ${cwd}.
The build takes a while \u2014 read flutter_log in a few seconds to see progress, and wait for 'app started' before sending a reload.`
        );
      } catch (e) {
        return apiErr(e);
      }
    }
  );
  for (const [name, op, what] of [
    ["flutter_reload", "reload", "Hot reload \u2014 keeps app state. The default after an edit."],
    ["flutter_restart", "restart", "Hot restart \u2014 rebuilds the app and LOSES state. For main(), provider wiring, enum/const/static initializers."]
  ]) {
    server.tool(
      name,
      what,
      { id: z.string().optional().describe("run id from flutter_list; omit when only one app is running") },
      async ({ id }) => {
        const run = await resolve(id);
        if (typeof run === "string") return ok(run);
        try {
          if (run.kind === "pane") {
            const key = op === "reload" ? "r" : "R";
            const r2 = await deckApi("/dt/keys", {
              method: "POST",
              body: JSON.stringify({ id: run.id, keys: [key] })
            });
            if (!r2.ok) return ok(`Deck refused the keystroke: ${r2.status} ${await r2.text()}`);
            return ok(`Sent '${key}' to the pane running ${run.device}. Read it with deck_term_read.`);
          }
          const r = await command(op, { id: run.id });
          if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
          return ok(`${op === "reload" ? "Reloading" : "Restarting"} ${run.device}. Check flutter_log for the result.`);
        } catch (e) {
          return apiErr(e);
        }
      }
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
          const r2 = await deckApi("/dt/keys", {
            method: "POST",
            body: JSON.stringify({ id: run.id, keys: ["q"] })
          });
          if (!r2.ok) return ok(`Deck refused the keystroke: ${r2.status} ${await r2.text()}`);
          return ok(`Sent 'q' to the pane running ${run.device}.`);
        }
        const r = await command("stop", { id: run.id });
        if (!r.ok) return ok(`Deck refused the command: ${r.status} ${await r.text()}`);
        return ok(`Stopping ${run.device}.`);
      } catch (e) {
        return apiErr(e);
      }
    }
  );
  server.tool(
    "flutter_log",
    "Read a Deck-run app's output \u2014 build progress, print/debugPrint, and developer.log lines that a plain `flutter run` never shows. Only for [deck] runs; use deck_term_read for a pane.",
    {
      id: z.string().optional().describe("run id from flutter_list; omit when only one app is running"),
      lines: z.number().int().positive().max(200).default(40),
      filter: z.string().optional().describe("only lines containing this text (case-insensitive)")
    },
    async ({ id, lines, filter }) => {
      const runs = pluginRuns();
      if (!runs.length) {
        return ok("No Deck-run app. A `flutter run` in a terminal pane is read with deck_term_read instead.");
      }
      const run = id ? runs.find((r) => r.id === id) : runs.length === 1 ? runs[0] : void 0;
      if (!run) {
        return ok("Several runs \u2014 pass an id:\n" + runs.map((r) => `  ${r.id}  ${r.deviceName}`).join("\n"));
      }
      const needle = filter?.toLowerCase();
      const picked = (needle ? run.log.filter((l) => l.text.toLowerCase().includes(needle)) : run.log).slice(-lines);
      const when = (ts) => new Date(ts).toISOString().slice(11, 19);
      return ok(
        `${run.deviceName} \u2014 ${run.status}

` + (picked.length ? picked.map((l) => `${when(l.ts)} ${l.logger ? `[${l.logger}] ` : ""}${l.text}`).join("\n") : "(no output yet)")
      );
    }
  );
}
export {
  register
};
