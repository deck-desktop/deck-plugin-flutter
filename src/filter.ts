// Turning what is typed in the filter box into a predicate.
//
// Its own module so it can be tested without importing plugin.tsx, which registers a window
// listener at module scope and therefore needs a DOM to import at all.
/** `/pattern/flags` — the slashes are what opt a query into regex. */
const DELIMITED = /^\/(.*)\/([gimsuy]*)$/;

/**
 * Does this query use regex SYNTAX? Not whether it compiles — `/foo[` is regex-shaped and broken.
 *
 * The UI needs the two apart: the `.*` switch lights up on syntax, and the "incomplete pattern"
 * note appears when that syntax does not yet compile.
 */
export const regexSyntax = (q: string) => DELIMITED.test(q.trim());

/** Does this query compile? False for a non-regex query, which has nothing to compile. */
export function validRegex(q: string): boolean {
  const m = DELIMITED.exec(q.trim());
  if (!m) return false;
  try { new RegExp(m[1], m[2].replace(/g/g, "")); return true; } catch { return false; }
}

/**
 * Build a matcher from what was typed.
 *
 * Plain text by default, since that is what a filter box is usually given. A pattern wrapped in
 * slashes (`/setState.*null/i`) is a regex — the delimiters are the opt-in, so a search for a
 * literal `.` or `(` does not silently become a wildcard.
 *
 * A half-typed regex (`/foo[`) is not an error: it cannot match anything useful yet, so it falls
 * back to a literal search and the box stays usable while you type the rest.
 */
export function matcher(q: string): (text: string) => boolean {
  const trimmed = q.trim();
  if (!trimmed) return () => true;
  const m = DELIMITED.exec(trimmed);
  if (m) {
    try {
      // `g` is dropped deliberately: lastIndex would make .test() alternate between hit and miss
      // across calls, so the same line would match on one render and not the next.
      const re = new RegExp(m[1], m[2].replace(/g/g, ""));
      return (text) => re.test(text);
    } catch { /* not valid yet — fall through to a literal search */ }
  }
  const needle = trimmed.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}
