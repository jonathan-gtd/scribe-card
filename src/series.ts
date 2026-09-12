/** Turning the rows of a query into datasets a chart can take.
 *
 * Kept apart from the card so the rules are readable on their own: which
 * column goes on the x axis and what kind it is, which columns are worth
 * drawing, and what a value that is not a number becomes.
 */

import type { Row } from "./types";

export interface Series {
  name: string;
  values: (number | null)[];
}

/** What the x axis holds, which is what decides the ECharts axis type. */
export type AxisKind = "time" | "number" | "category";

export interface Chart {
  kind: AxisKind;
  /** Milliseconds for `time`, the value for `number`, the label for `category`. */
  x: (number | string)[];
  series: Series[];
}

const TIME_COLUMNS = ["time", "bucket", "timestamp", "ts", "day", "hour", "minute"];

/** A timestamp in milliseconds, or null when the value is not a date. */
function asTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Only a number big enough to be an epoch is read as one: `SELECT
    // extract(hour from time)` gives 0 to 23, and an axis of hours must not
    // become an axis of dates in January 1970.
    if (value >= 1e11) return value; // milliseconds
    if (value >= 1e8) return value * 1000; // seconds, from 1973 onwards
    return null;
  }
  if (typeof value === "string") {
    // Only what looks like a date: Date.parse("5") answers, and would turn a
    // category axis into a time axis.
    if (!/[-:T]/.test(value)) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** The column to put on the x axis: the one asked for, a time-looking one, or the first. */
export function pickXColumn(columns: string[], asked?: string): string {
  if (asked) return asked;
  const byName = columns.find((c) => TIME_COLUMNS.includes(c.toLowerCase()));
  return byName ?? columns[0];
}

/** The columns to draw: those asked for, or every numeric column besides x. */
export function pickYColumns(rows: Row[], x: string, asked?: string | string[]): string[] {
  if (asked) return Array.isArray(asked) ? asked : [asked];
  const columns = Object.keys(rows[0] ?? {}).filter((c) => c !== x);
  return columns.filter((c) => rows.some((row) => asNumber(row[c]) !== null));
}

/** What the x column holds: dates, numbers, or labels to put side by side. */
export function axisKind(rows: Row[], xColumn: string): AxisKind {
  const values = rows.map((row) => row[xColumn]).filter((v) => v !== null && v !== undefined);
  if (values.length === 0) return "category";
  if (values.every((v) => asTime(v) !== null)) return "time";
  if (values.every((v) => asNumber(v) !== null)) return "number";
  return "category";
}

/**
 * Rows to a chart.
 *
 * A missing or non-numeric y is a gap rather than a zero: a sensor that
 * reported nothing did not report zero. Time and number axes are sorted, since
 * a query without ORDER BY is common; a category axis keeps the order the
 * query returned, which is usually an ORDER BY of its own.
 */
export function toChart(
  rows: Row[],
  xColumn: string,
  yColumns: string[],
  forced?: AxisKind,
): Chart {
  // Guessing is right almost always; `forced` is for the almost.
  const kind = forced ?? axisKind(rows, xColumn);

  const x: (number | string)[] = [];
  const series: Series[] = yColumns.map((name) => ({ name, values: [] }));

  for (const row of rows) {
    const raw = row[xColumn];
    const value =
      kind === "time" ? asTime(raw) : kind === "number" ? asNumber(raw) : String(raw ?? "");
    if (value === null) continue;
    x.push(value);
    yColumns.forEach((column, index) => series[index].values.push(asNumber(row[column])));
  }

  if (kind === "category") return { kind, x, series };

  const order = x.map((_, index) => index).sort((a, b) => (x[a] as number) - (x[b] as number));
  return {
    kind,
    x: order.map((index) => x[index]),
    series: series.map((s) => ({ name: s.name, values: order.map((index) => s.values[index]) })),
  };
}
