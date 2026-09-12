/** The one path from a card to the database.
 *
 * The card and its editor both ask the same question in the same way, and both
 * used to carry their own copy of it. Here it is once, with the two things that
 * copy never did: it says so when Scribe is not there at all, and it does not
 * ask twice for an answer it is already waiting on.
 */

import type { HomeAssistant, Row } from "./types";

/**
 * Long enough to fuse the editor's two questions — the form asks for the
 * columns, the preview beside it draws the rows — and far below the five
 * seconds a refresh is floored at, so a refresh always reaches the database.
 */
const CACHE_MS = 2000;

const cache = new Map<string, { at: number; rows: Promise<Row[]> }>();

async function ask(hass: HomeAssistant, sql: string): Promise<Row[]> {
  const result = await hass.callService("scribe", "query", { sql }, undefined, false, true);
  const rows = (result?.response as { result?: Row[] } | undefined)?.result;
  if (!Array.isArray(rows)) throw new Error("the query returned no rows array");
  return rows;
}

/**
 * Run a query through Scribe.
 *
 * `fresh` skips the cache, which is what a refresh means: the card is asking
 * precisely because time has passed.
 */
export function runQuery(hass: HomeAssistant, sql: string, fresh = false): Promise<Row[]> {
  // `services` is absent on nothing a real frontend hands a card, so its
  // absence is not treated as an answer either way.
  if (hass.services && !hass.services.scribe?.query) {
    return Promise.reject(
      new Error(
        "Scribe is not installed, or is older than 4.0 — this card draws what its `scribe.query` service returns.",
      ),
    );
  }

  const now = Date.now();
  for (const [key, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(key);

  if (!fresh) {
    const waiting = cache.get(sql);
    if (waiting) return waiting.rows;
  }

  const rows = ask(hass, sql);
  cache.set(sql, { at: now, rows });
  // A query that failed is not an answer worth handing to the next asker.
  rows.catch(() => cache.delete(sql));
  return rows;
}
