// The network profile of a run: HTTP logging switched on in each isolate over the VM Service
// socket, and the calls read back from dart:io's profile into `run.net`. Moved out of store.ts,
// which owns the socket and the runs; this only speaks the VM Service on it.
import { parseProfile, mergeCalls } from "./net.js";
import type { Run } from "./store.js";

/** Per run, what only the store needs for the network profile: never rendered. */
export interface NetState {
  /** Isolates with HTTP logging switched on, each with the `updatedSince` for its next read. */
  since: Map<string, number>;
  /** Replies awaited on the VM Service socket, by request id. */
  pending: Map<string, (result: unknown) => void>;
  polling?: boolean;
}
export const netState = new Map<string, NetState>();
/** How many calls to keep per run. A busy app makes thousands; the panel is for the recent ones. */
const MAX_NET = 1000;
let rpcSeq = 0;

/**
 * A VM Service call on the run's socket, resolving to its result (undefined on an error reply).
 *
 * The socket is shared with the log streams, so replies are told apart by id: ours are "n<seq>",
 * which the subscribe requests ("1", "2") never are.
 */
export function rpc(run: Run, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const ns = netState.get(run.id);
  if (!ns || run.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
  const id = `n${++rpcSeq}`;
  return new Promise((resolve) => {
    ns.pending.set(id, resolve);
    run.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    // A reply that never comes (the app died mid-call) must not keep the promise, or the poll, waiting.
    setTimeout(() => { if (ns.pending.delete(id)) resolve(undefined); }, 10_000);
  });
}

/**
 * A frame that is ours: a reply to `rpc`, or an Isolate stream event. True when handled.
 *
 * Cheap tests first: most frames are log records, and parsing each a second time to find out it is
 * not a reply would double the work of a chatty app's log.
 */
export function netFrame(run: Run, ns: NetState, frame: string): boolean {
  const reply = ns.pending.size > 0 && frame.includes('"id":"n');
  const isolate = frame.includes('"streamId":"Isolate"');
  if (!reply && !isolate) return false;
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(frame) as Record<string, unknown>; } catch { return false; }
  const id = typeof msg.id === "string" ? msg.id : "";
  const done = ns.pending.get(id);
  if (done) { ns.pending.delete(id); done(msg.result); return true; }
  const event = ((msg.params as Record<string, unknown> | undefined)?.event ?? {}) as Record<string, unknown>;
  const iso = String((event.isolate as Record<string, unknown> | undefined)?.id ?? "");
  // A new isolate (a hot restart makes one, as does Isolate.spawn) gets logging the moment dart:io
  // registers its extension; until then there is nothing to switch on.
  if (event.kind === "ServiceExtensionAdded" && event.extensionRPC === "ext.dart.io.httpEnableTimelineLogging" && iso) {
    void enableIn(run, iso);
  }
  if (event.kind === "IsolateExit" && iso) ns.since.delete(iso);
  return isolate;
}

/**
 * Switch on HTTP logging in every isolate now, and in every one that starts later.
 *
 * Retried for up to a minute until one isolate takes it. The socket can open before dart:io has
 * registered its extension, so the first try fails; and the "extension added" event that would
 * have caught it can arrive before the Isolate stream subscription is in place. Without the retry
 * a run sometimes recorded nothing at all.
 */
export async function startHttpLogging(run: Run) {
  await rpc(run, "streamListen", { streamId: "Isolate" });
  for (let i = 0; i < 120; i++) {
    const ns = netState.get(run.id);
    if (!ns || run.ws?.readyState !== WebSocket.OPEN || ns.since.size) return;
    const vm = (await rpc(run, "getVM")) as { isolates?: { id: string }[] } | undefined;
    await Promise.all((vm?.isolates ?? []).map((iso) => enableIn(run, iso.id)));
    if (!ns.since.size) await new Promise((r) => setTimeout(r, 500));
  }
}

async function enableIn(run: Run, iso: string) {
  const r = (await rpc(run, "ext.dart.io.httpEnableTimelineLogging", { isolateId: iso, enabled: "true" })) as
    { enabled?: boolean } | undefined;
  const ns = netState.get(run.id);
  if (r?.enabled && ns && !ns.since.has(iso)) ns.since.set(iso, 0);
}

/** Read what changed in each isolate's profile since the last read, into `run.net`. */
export async function pollNet(run: Run, changed: () => void) {
  const ns = netState.get(run.id);
  // One read at a time: a slow app (paused at a breakpoint) would otherwise stack a read a second.
  if (!ns || ns.polling) return;
  ns.polling = true;
  try { await readProfiles(run, ns, changed); } finally { ns.polling = false; }
}
async function readProfiles(run: Run, ns: NetState, changed: () => void) {
  for (const [iso, since] of ns.since) {
    const r = await rpc(run, "ext.dart.io.getHttpProfile", since ? { isolateId: iso, updatedSince: since } : { isolateId: iso });
    if (!r) continue;
    const p = parseProfile(r);
    if (ns.since.has(iso)) ns.since.set(iso, p.since);
    const next = mergeCalls(run.net, p.calls, MAX_NET);
    if (next !== run.net) { run.net = next; changed(); }
  }
}
