/** The window of time a card is looking at.
 *
 * A query with a period written into it shows that period and no other: the
 * same chart over a day and over a month means two cards, with two
 * `time_bucket()` calls, because a bucket of one minute over thirty days is
 * forty-three thousand points.
 *
 * So the query leaves holes, and the card fills them — `$__from`, `$__to` and
 * `$__interval`, the way Grafana does it. Everything substituted is built here
 * from a duration the card validated; nothing a user typed reaches the SQL.
 *
 * Pure: no DOM, no ECharts import.
 */

import { usesAmPm } from "./locale";
import type { HassLocale } from "./types";

/** The last so much of something, or two instants. Both survive JSON, which is
 * what the card remembers between visits. */
export type Range = { last: string } | { from: number; to: number };

const DURATION = /^(\d+)([mhdwy])$/;

const MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

const UNITS: Record<string, string> = {
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  y: "year",
};

/** What the picker offers when the card names no ranges of its own. */
export const DEFAULT_RANGES = ["1h", "6h", "24h", "7d", "30d", "90d", "1y"];

/**
 * The buckets a range can be cut into, coarsest last.
 *
 * Nothing above a week: `time_bucket()` wants a fixed width, and a month is
 * not one.
 */
const BUCKETS: [string, number][] = [
  ["1 minute", 60_000],
  ["5 minutes", 300_000],
  ["15 minutes", 900_000],
  ["30 minutes", 1_800_000],
  ["1 hour", 3_600_000],
  ["3 hours", 10_800_000],
  ["6 hours", 21_600_000],
  ["12 hours", 43_200_000],
  ["1 day", 86_400_000],
  ["1 week", 604_800_000],
  // A month is not a fixed width, and `time_bucket` only takes one when it is
  // also told which calendar to count in — which `$__timezone` provides.
  ["1 month", 2_592_000_000],
];

/** Points beyond this are a chart nobody reads and rows nobody needed. */
const MAX_POINTS = 400;

/** A duration in milliseconds, or null when the text is not one. */
export function parseDuration(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const parsed = DURATION.exec(text.trim());
  if (!parsed) return null;
  const count = Number(parsed[1]);
  return count > 0 ? count * MS[parsed[2]] : null;
}

/** Whether a value read back from storage is still a range this card knows. */
export function isRange(value: unknown): value is Range {
  if (!value || typeof value !== "object") return false;
  const range = value as Record<string, unknown>;
  if (typeof range.last === "string") return parseDuration(range.last) !== null;
  return (
    typeof range.from === "number" &&
    typeof range.to === "number" &&
    Number.isFinite(range.from) &&
    Number.isFinite(range.to) &&
    range.to > range.from
  );
}

/** The two instants a range means, at a given moment. */
export function resolve(range: Range, now: number): { from: number; to: number } {
  if ("last" in range) {
    const span = parseDuration(range.last) ?? MS.d;
    return { from: now - span, to: now };
  }
  return { from: range.from, to: range.to };
}

/** The finest bucket that keeps a range under a few hundred points. */
export function bucketFor(span: number): string {
  for (const [interval, width] of BUCKETS) {
    if (span / width <= MAX_POINTS) return interval;
  }
  return BUCKETS[BUCKETS.length - 1][0];
}

/** Whether a query leaves anything for a range to fill. */
export function hasMarkers(sql: string): boolean {
  return /\$__(from|to|interval|timeFilter|timezone)\b/.test(sql);
}

/**
 * `$__timeFilter(column)`, which is how Grafana spells it.
 *
 * Anyone who has written a dashboard there reaches for it without thinking,
 * and writing `column >= $__from AND column < $__to` by hand says the same
 * thing three times over. Only a plain column name is accepted — anything else
 * is left exactly as it was written rather than guessed at.
 */
const TIME_FILTER =
  /\$__timeFilter\(\s*("?[A-Za-z_][A-Za-z0-9_$]*"?(?:\.\s*"?[A-Za-z_][A-Za-z0-9_$]*"?)?)\s*\)/g;

/**
 * The query, with the range written into it.
 *
 * Fixed instants rather than `now()`: both ends and every bucket then agree
 * with each other, however many times the query mentions them.
 */
export function substitute(sql: string, range: Range, now: number, timezone?: string): string {
  const { from, to } = resolve(range, now);
  const stamp = (at: number) => `'${new Date(at).toISOString()}'::timestamptz`;
  // A timezone only ever comes from the browser or Home Assistant, and an
  // Olson name has no room for anything else in it.
  const zone = /^[A-Za-z][A-Za-z0-9+\-_/]*$/.test(timezone ?? "") ? timezone : "UTC";

  return sql
    .replace(TIME_FILTER, (_, column) => `${column} >= ${stamp(from)} AND ${column} < ${stamp(to)}`)
    .replaceAll("$__interval", `'${bucketFor(to - from)}'`)
    .replaceAll("$__timezone", `'${zone}'`)
    .replaceAll("$__from", stamp(from))
    .replaceAll("$__to", stamp(to));
}

/**
 * A range to read a query with when nobody has chosen one yet.
 *
 * The editor runs the query only to learn its column names, and a query full
 * of markers has to be filled in before it will run at all.
 */
export function defaultRange(ranges?: string[]): Range {
  const first = ranges?.find((text) => parseDuration(text) !== null);
  return { last: first ?? "24h" };
}

/** What the picker shows for a range. */
export function labelFor(range: Range, locale?: HassLocale): string {
  if ("last" in range) {
    const parsed = DURATION.exec(range.last);
    if (!parsed) return range.last;
    const count = Number(parsed[1]);
    const unit = UNITS[parsed[2]];
    return count === 1 ? `Last ${unit}` : `Last ${count} ${unit}s`;
  }

  // A date is written in the language, not in the convention that decides
  // where a decimal separator goes.
  let format: Intl.DateTimeFormat | undefined;
  try {
    format = new Intl.DateTimeFormat(locale?.language || undefined, {
      dateStyle: "short",
      timeStyle: "short",
      hour12: usesAmPm(locale),
    });
  } catch {
    format = undefined;
  }
  const at = (ms: number) => (format ? format.format(new Date(ms)) : new Date(ms).toISOString());
  return `${at(range.from)} — ${at(range.to)}`;
}
