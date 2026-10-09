// The Network view: the app's HTTP calls, beside its log in the Flutter drawer.
//
// The calls come from the VM Service (see net.ts and the store), so the app needs no interceptor
// and no package of its own. The list is the profile's summary; a call's bodies are fetched only
// when it is selected, because the profile sends them as a list of byte values and most calls
// are never opened.
import { useEffect, useRef, useState } from "react";
import { Copy, Trash2, X, Terminal } from "lucide-react";
import { useResize } from "../shim/ui.js";
import { monaco } from "../shim/monaco.js";
import * as store from "./store.js";
import { matcher } from "./filter.js";
import { bodyText, curlOf, duration, type NetCall } from "./net.js";

const statusColor = (c: NetCall) =>
  c.error ? "#f87171"
    : c.status === undefined ? "var(--text-muted)"
    : c.status >= 500 ? "#f87171" : c.status >= 400 ? "#fbbf24" : c.status >= 300 ? "#60a5fa" : "#34d399";

const size = (n: number) => (n < 0 ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ms = (c: NetCall) => { const d = duration(c); return d === undefined ? "…" : d < 1000 ? `${d} ms` : `${(d / 1000).toFixed(2)} s`; };
const keyOf = (c: NetCall) => `${c.isolateId}/${c.id}`;
const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

/** The details pane's width (beside the list) and height (under it), kept per machine. */
const SIZE_KEY = "deck.flutter.network";
const kept: { w: number; h: number } = (() => {
  try { return { w: 440, h: 320, ...JSON.parse(localStorage.getItem(SIZE_KEY) ?? "{}") }; }
  catch { return { w: 440, h: 320 }; }
})();

export function NetworkView({ run, leading }: { run: store.Run; leading?: React.ReactNode }) {
  useEffect(() => store.watchNet(run.id), [run.id]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const match = matcher(q);
  const calls = run.net;
  const shown = q.trim()
    ? calls.filter((c) => match(c.uri) || match(c.method) || match(String(c.status ?? c.error ?? "")))
    : calls;
  const sel = calls.find((c) => keyOf(c) === picked) ?? null;

  // Too narrow for the list and the details side by side (a narrow pane, a split drawer): the
  // details go under the list instead. Measured, since the drawer's width is not the window's.
  const splitRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The handle between the list and the details. `invert`: the details sit after it.
  const [detailW, dragW] = useResize({ initial: kept.w, min: 280, max: 2000, direction: "horizontal", invert: true });
  const [detailH, dragH] = useResize({ initial: kept.h, min: 120, max: 2000, direction: "vertical", invert: true });
  useEffect(() => {
    Object.assign(kept, { w: detailW, h: detailH });
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(kept)); } catch { /* private mode */ }
  }, [detailW, detailH]);

  // Follow new calls only when already at the bottom, as the log does.
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-subtle px-2 py-1">
        {leading}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter calls…" spellCheck={false}
          className="w-60 rounded border border-subtle bg-card px-2 py-0.5 font-mono text-[11px] text-text-primary outline-none placeholder:font-sans placeholder:text-text-muted focus:border-accent-soft" />
        <span className="text-[10px] text-text-muted">
          {shown.length}{shown.length !== calls.length && ` / ${calls.length}`} calls
        </span>
        <button onClick={() => { store.clearNet(run.id); setPicked(null); }} title="Clear the calls"
          className="ml-auto rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary">
          <Trash2 size={12} />
        </button>
      </div>
      <div ref={splitRef} className={`flex min-h-0 flex-1 ${narrow ? "flex-col" : ""}`}>
        <div ref={listRef} className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto font-mono text-[11px]"
          onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
          {shown.map((c) => {
            let path = c.uri, host = "";
            try { const u = new URL(c.uri); path = u.pathname + u.search; host = u.host; } catch { /* not a URL: show it whole */ }
            return (
              <button key={keyOf(c)} onClick={() => setPicked(keyOf(c))} title={c.uri}
                className={`flex w-full items-center gap-2 border-b border-white/5 px-2 py-1.5 text-left hover:bg-white/5 ${keyOf(c) === picked ? "bg-white/10" : ""}`}>
                <span className="w-12 shrink-0 font-semibold text-text-secondary">{c.method}</span>
                <span className="w-9 shrink-0 tabular-nums" style={{ color: statusColor(c) }}>{c.error ? "ERR" : c.status ?? "…"}</span>
                {/* The path is what tells calls apart; the host, the same for most of them, goes under it. */}
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-text-primary">{path}</span>
                  {host && <span className="truncate text-[10px] text-text-muted">{host}</span>}
                </span>
                <span className="ml-auto w-16 shrink-0 text-right tabular-nums text-text-muted">{ms(c)}</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-text-muted">{size(c.resSize)}</span>
              </button>
            );
          })}
          {!shown.length && (
            <div className="px-3 py-3 font-sans text-text-muted">
              {calls.length ? "Nothing matches this filter."
                : run.ws ? "No HTTP calls yet. Calls made through dart:io (package:http, dio) show here."
                : "Waiting for the app's VM Service…"}
            </div>
          )}
        </div>
        {sel && <div {...(narrow ? dragH : dragW)} title="Drag to resize"
          className={`shrink-0 transition-colors hover:bg-white/20 ${narrow ? "h-1 cursor-row-resize" : "w-1 cursor-col-resize"}`} />}
        {sel && <CallDetail key={keyOf(sel)} runId={run.id} call={sel} below={narrow} size={narrow ? detailH : detailW}
          onClose={() => setPicked(null)} />}
      </div>
    </div>
  );
}

/** One call: the general facts, then headers and bodies each way. */
function CallDetail({ runId, call, below, size: px, onClose }: { runId: string; call: NetCall; below: boolean; size: number; onClose: () => void }) {
  const [full, setFull] = useState<{ req: string; res: string; reqType: string; resType: string; raw: string } | null>(null);
  // Fetched again when the call finishes: a body read while it was in flight is partial.
  useEffect(() => {
    let alive = true;
    void store.netBodies(runId, call).then((b) => {
      if (!alive || !b) return;
      const ct = (h: Record<string, string>) => Object.entries(h).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
      const reqType = ct(b.call.reqHeaders), resType = ct(b.call.resHeaders);
      setFull({
        req: bodyText(b.req, reqType), res: bodyText(b.res, resType), reqType, resType,
        raw: b.req?.length ? new TextDecoder().decode(new Uint8Array(b.req)) : "",
      });
    });
    return () => { alive = false; };
  }, [runId, call.id, call.isolateId, call.end]);

  const section = (title: string, body: React.ReactNode) => (
    <details open className="border-b border-subtle">
      <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</summary>
      <div className="px-2 pb-2">{body}</div>
    </details>
  );
  const headers = (h: Record<string, string>) => Object.keys(h).length
    ? <div className="grid grid-cols-[max-content_1fr] gap-x-3 font-mono text-[11px]">
        {Object.entries(h).map(([k, v]) => [
          <span key={k} className="text-text-muted">{k}</span>,
          <span key={k + "="} className="select-text break-all text-text-primary">{v}</span>,
        ])}
      </div>
    : <span className="text-[11px] text-text-muted">None</span>;
  const body = (t: string | undefined, type: string) => t === undefined ? <span className="text-[11px] text-text-muted">Loading…</span>
    // bodyText's note for a body that is not text, e.g. "(4,096 bytes of image/png)".
    : /^\(\d[\d,]* bytes of /.test(t) ? <span className="text-[11px] text-text-muted">{t}</span>
    : t ? <BodyView text={t} type={type} />
    : <span className="text-[11px] text-text-muted">Empty</span>;

  return (
    // Sized by the handle, but never so large that the list disappears behind it.
    <div className={`scroll-thin flex shrink-0 flex-col overflow-y-auto border-subtle ${below ? "border-t" : "border-l"}`}
      style={below ? { height: px, maxHeight: "calc(100% - 60px)" } : { width: px, maxWidth: "calc(100% - 200px)" }}>
      <div className="flex items-start gap-1 border-b border-subtle px-2 py-1.5">
        <div className="min-w-0 flex-1 font-mono text-[11px]">
          <span className="mr-1.5 font-semibold text-text-secondary">{call.method}</span>
          <span className="select-text break-all text-text-primary">{call.uri}</span>
          <div className="mt-0.5 text-text-muted">
            <span style={{ color: statusColor(call) }}>{call.error ?? (call.status !== undefined ? `${call.status} ${call.reason ?? ""}` : "in flight")}</span>
            {" · "}{ms(call)}{call.resSize >= 0 && ` · ${size(call.resSize)}`}{" · "}{new Date(call.start).toLocaleTimeString()}
          </div>
        </div>
        <button onClick={() => copy(call.uri)} title="Copy the URL" className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary"><Copy size={12} /></button>
        <button onClick={() => copy(curlOf(call, full?.raw ?? ""))} title="Copy as cURL" className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary"><Terminal size={12} /></button>
        <button onClick={onClose} title="Close" className="rounded p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary"><X size={12} /></button>
      </div>
      {section("Request headers", headers(call.reqHeaders))}
      {section("Request body", body(full?.req, full?.reqType ?? ""))}
      {section("Response headers", headers(call.resHeaders))}
      {section("Response body", body(full?.res, full?.resType ?? ""))}
    </div>
  );
}

/**
 * A body in Deck's Monaco, read-only: highlighted, with fold arrows on every object and array.
 *
 * As tall as its content up to a cap, so a short body takes a few lines and a long one scrolls
 * inside itself. The mouse wheel passes through to the details pane at the editor's ends, so
 * scrolling past a body does not get stuck in it. Disposed with its model on unmount (rule 8).
 */
function BodyView({ text, type }: { text: string; type: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(40);
  useEffect(() => {
    if (!host.current) return;
    const language = /^\s*[[{]/.test(text) ? "json" : /html/i.test(type) ? "html" : /xml/i.test(type) ? "xml" : "plaintext";
    const ed = monaco.editor.create(host.current, {
      value: text, language, theme: "deck-dark", readOnly: true, domReadOnly: true,
      minimap: { enabled: false }, lineNumbers: "off", glyphMargin: false,
      folding: true, showFoldingControls: "always", lineDecorationsWidth: 4,
      wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true,
      fontSize: 11, renderLineHighlight: "none", contextmenu: false,
      scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 8 },
      padding: { top: 4, bottom: 4 },
    });
    const fit = () => setHeight(Math.min(ed.getContentHeight(), 480));
    const sub = ed.onDidContentSizeChange(fit);
    fit();
    return () => { sub.dispose(); const model = ed.getModel(); ed.dispose(); model?.dispose(); };
  }, [text, type]);
  return <div ref={host} className="overflow-hidden rounded border border-subtle" style={{ height }} />;
}
