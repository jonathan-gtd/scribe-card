/** Turning the rows of a query into something a chart can take.
 *
 * Kept apart from the card so the rules are readable on their own: which
 * column is time, which columns are worth drawing, and what a value that is
 * not a number becomes.
 */

import type { Row } from "./types";

export interface Series {
  name: string;
  values: (number | null)[];
}

export interface Chart {
  x: number[];
  /** True when the x values are timestamps, in seconds. */
  xIsTime: boolean;
  series: Series[];
}

const TIME_COLUMNS = ["time", "bucket", "timestamp", "ts", "day", "hour", "minute"];

/** A timestamp as a number of seconds, or null when the value is not a date. */
function asTime(value: unknown): number | null {
  if (typeof value === "number") {
    // Postgres `epoch` comes back in seconds; milliseconds are also plausible.
    return value > 1e11 ? value / 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed / 1000;
  }
  if (value instanceof Date) return value.getTime() / 1000;
  return null;
}

function asNumber(value: unknown): number | null {
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
  const numeric = columns.filter((c) => rows.some((row) => asNumber(row[c]) !== null));
  // A query that selects only text still draws nothing useful, but saying
  // "no numeric column" is a better error than an empty chart.
  return numeric;
}

/**
 * Rows to a chart, dropping rows whose x value makes no sense.
 *
 * A missing or non-numeric y is kept as a gap rather than as a zero: a sensor
 * that reported nothing did not report zero.
 */
export function toChart(rows: Row[], xColumn: string, yColumns: string[]): Chart {
  const xIsTime = rows.some(
    (row) => typeof row[xColumn] !== "number" && asTime(row[xColumn]) !== null,
  );

  const x: number[] = [];
  const series: Series[] = yColumns.map((name) => ({ name, values: [] }));

  for (const row of rows) {
    const raw = row[xColumn];
    const value = xIsTime ? asTime(raw) : asNumber(raw);
    if (value === null) continue;
    x.push(value);
    yColumns.forEach((column, index) => series[index].values.push(asNumber(row[column])));
  }

  // uPlot needs the x values ordered; a query without ORDER BY is common.
  const order = x.map((_, index) => index).sort((a, b) => x[a] - x[b]);
  return {
    x: order.map((index) => x[index]),
    xIsTime,
    series: series.map((s) => ({ name: s.name, values: order.map((index) => s.values[index]) })),
  };
}
