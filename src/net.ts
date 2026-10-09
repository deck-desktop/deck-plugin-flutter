// The app's HTTP calls, read from the VM Service's dart:io HTTP profile.
//
// This is the source DevTools' Network tab reads. Once `ext.dart.io.httpEnableTimelineLogging` is
// switched on in an isolate, dart:io records every HttpClient request it makes, which covers
// package:http, dio's default adapter and anything else built on dart:io, with no change to the
// app. Not covered: Flutter web (no Dart VM), native adapters such as cupertino_http and
// cronet_http, and traffic made by native SDKs or WebViews.
//
// A call made before logging is switched on is never recorded, so the store switches it on the
// moment the socket opens, and again in every isolate that appears later (a hot restart is one).
//
// Pure functions over the decoded JSON, so flutter.check can test them without a VM.

/** One HTTP call, as the panel lists it. */
export interface NetCall {
  /** The profile's id, unique within its isolate; the key for fetching the bodies. */
  id: string;
  isolateId: string;
  method: string;
  uri: string;
  /** ms since the epoch. The profile counts in microseconds. */
  start: number;
  /** Absent while the call is in flight. */
  end?: number;
  status?: number;
  reason?: string;
  /** Set when the call failed without a response: a refused connection, a timeout, a bad host. */
  error?: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  /** Bytes, from Content-Length; -1 when unknown (a chunked upload, a stream). */
  reqSize: number;
  resSize: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** dart:io gives each header as a list of values; one string per header reads like a request. */
function headers(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, vals] of Object.entries(obj(v))) out[k] = Array.isArray(vals) ? vals.join(", ") : String(vals);
  return out;
}

/** One `@HttpProfileRequest` (or the full `HttpProfileRequest`) as a NetCall. */
export function toCall(r: unknown): NetCall {
  const o = obj(r), req = obj(o.request), res = obj(o.response);
  const us = (v: unknown) => (num(v) !== undefined ? Math.round(num(v)! / 1000) : undefined);
  // The response's end is when the body finished; the call's own endTime is when the request
  // was sent, which is not what "how long did it take" means.
  const end = us(res.endTime) ?? (str(req.error) || str(res.error) ? us(o.endTime) : undefined);
  return {
    id: str(o.id), isolateId: str(o.isolateId), method: str(o.method), uri: str(o.uri),
    start: us(o.startTime) ?? 0, end,
    status: num(res.statusCode), reason: str(res.reasonPhrase) || undefined,
    error: str(res.error) || str(req.error) || undefined,
    reqHeaders: headers(req.headers), resHeaders: headers(res.headers),
    reqSize: num(req.contentLength) ?? -1, resSize: num(res.contentLength) ?? -1,
  };
}

/**
 * A `getHttpProfile` result: the calls, and the timestamp to pass as `updatedSince` next time so
 * only the calls that changed since come back.
 */
export function parseProfile(result: unknown): { since: number; calls: NetCall[] } {
  const o = obj(result);
  return { since: num(o.timestamp) ?? 0, calls: (Array.isArray(o.requests) ? o.requests : []).map(toCall) };
}

/**
 * Merge an update into the list: a call seen before is replaced in place (it finished, or failed),
 * a new one goes on the end. Keeps at most `max`, dropping the oldest.
 */
export function mergeCalls(list: NetCall[], update: NetCall[], max: number): NetCall[] {
  if (!update.length) return list;
  const at = new Map(list.map((c, i) => [`${c.isolateId}/${c.id}`, i]));
  const next = list.slice();
  for (const c of update) {
    const i = at.get(`${c.isolateId}/${c.id}`);
    if (i === undefined) { at.set(`${c.isolateId}/${c.id}`, next.length); next.push(c); }
    else next[i] = c;
  }
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * A body as text to show: pretty-printed when it is JSON, a note when it is not text at all.
 *
 * The profile sends bodies as a list of byte values. Capped, because a download of a few MB is
 * text nobody reads in a side panel and would stall the render.
 */
export function bodyText(bytes: number[] | undefined, contentType = "", cap = 200_000): string {
  if (!bytes?.length) return "";
  if (/^(image|audio|video|font)\/|octet-stream|application\/(pdf|zip|protobuf)/i.test(contentType)) {
    return `(${bytes.length.toLocaleString()} bytes of ${contentType.split(";")[0]})`;
  }
  const text = new TextDecoder().decode(new Uint8Array(bytes.slice(0, cap)));
  const more = bytes.length > cap ? `\n… ${(bytes.length - cap).toLocaleString()} more bytes not shown` : "";
  try { return JSON.stringify(JSON.parse(text), null, 2) + more; } catch { return text + more; }
}

/** The call as a cURL command, to replay it in a terminal. Headers dart:io adds itself are left out. */
export function curlOf(c: NetCall, body = ""): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const skip = new Set(["content-length", "host", "transfer-encoding", "accept-encoding", "user-agent"]);
  const parts = ["curl", ...(c.method === "GET" ? [] : ["-X", c.method]), q(c.uri)];
  for (const [k, v] of Object.entries(c.reqHeaders)) if (!skip.has(k.toLowerCase())) parts.push("-H", q(`${k}: ${v}`));
  if (body) parts.push("--data-raw", q(body));
  return parts.join(" ");
}

/** Milliseconds a call took, or undefined while it is still running. */
export const duration = (c: NetCall) => (c.end !== undefined ? Math.max(0, c.end - c.start) : undefined);
