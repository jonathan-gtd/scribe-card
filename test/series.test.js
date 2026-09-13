/** What a query's rows become on a chart.
 *
 * The card hands whatever the database returned to these functions, so they
 * meet text where numbers were expected, nulls, unordered rows and columns
 * nobody can draw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  asPercentages,
  pickXColumn,
  pickYColumns,
  sortCategories,
  toChart,
} from "../.test/series.js";

test("the x column is the one that looks like time", () => {
  assert.equal(pickXColumn(["entity_id", "time", "value"]), "time");
  assert.equal(pickXColumn(["bucket", "avg"]), "bucket");
  // Nothing time-like: the first column, so a plain two-column query works.
  assert.equal(pickXColumn(["room", "degrees"]), "room");
  // What the configuration asks for always wins.
  assert.equal(pickXColumn(["time", "value"], "value"), "value");
});

test("only the numeric columns are drawn", () => {
  const rows = [
    { time: "2026-09-12T10:00:00Z", entity_id: "sensor.a", value: 21.5, state: null },
    { time: "2026-09-12T11:00:00Z", entity_id: "sensor.a", value: 22, state: null },
  ];
  assert.deepEqual(pickYColumns(rows, "time"), ["value"]);
  // A query of nothing but text draws nothing, and the card says so.
  assert.deepEqual(pickYColumns([{ time: "x", state: "on" }], "time"), []);
});

test("rows become a chart, in time order", () => {
  const rows = [
    { time: "2026-09-12T11:00:00Z", value: 22 },
    { time: "2026-09-12T10:00:00Z", value: 21 },
  ];
  const chart = toChart(rows, "time", ["value"]);

  assert.equal(chart.kind, "time");
  assert.deepEqual(chart.series[0].values, [21, 22], "the unordered query is sorted");
  assert.ok(chart.x[0] < chart.x[1]);
  assert.equal(
    chart.x[0],
    Date.parse("2026-09-12T10:00:00Z"),
    "milliseconds, as ECharts' time axis wants",
  );
});

test("a value that is not a number is a gap, not a zero", () => {
  const rows = [
    { time: "2026-09-12T10:00:00Z", value: 21 },
    { time: "2026-09-12T11:00:00Z", value: null },
    { time: "2026-09-12T12:00:00Z", value: "unavailable" },
    { time: "2026-09-12T13:00:00Z", value: "23.5" },
  ];

  const chart = toChart(rows, "time", ["value"]);

  assert.deepEqual(chart.series[0].values, [21, null, null, 23.5]);
});

test("a column that is not all dates is read as labels, not half a timeline", () => {
  const rows = [
    { time: "not a date", value: 1 },
    { time: "2026-09-12T10:00:00Z", value: 2 },
  ];

  const chart = toChart(rows, "time", ["value"]);

  // Dropping the odd row would draw a timeline missing a point nobody
  // mentioned; treating the column as labels shows exactly what came back.
  assert.equal(chart.kind, "category");
  assert.deepEqual(chart.x, ["not a date", "2026-09-12T10:00:00Z"]);
  assert.deepEqual(chart.series[0].values, [1, 2]);
});

test("a numeric x axis is left alone", () => {
  const rows = [
    { hour: 3, count: 10 },
    { hour: 1, count: 30 },
  ];

  const chart = toChart(rows, "hour", ["count"]);

  assert.equal(chart.kind, "number", "an hour number is not a timestamp");
  assert.deepEqual(chart.x, [1, 3]);
  assert.deepEqual(chart.series[0].values, [30, 10]);
});

test("a date column lands on milliseconds, whatever it was written as", () => {
  const iso = toChart([{ t: "2026-09-12T10:00:00Z", v: 1 }], "t", ["v"]);
  assert.equal(iso.kind, "time");
  assert.equal(iso.x[0], Date.parse("2026-09-12T10:00:00Z"));

  // A plain number is a number: `SELECT extract(hour from time)` is an axis of
  // hours, not of dates in 1970.
  const hours = toChart([{ t: 14, v: 1 }], "t", ["v"]);
  assert.equal(hours.kind, "number");
  assert.equal(hours.x[0], 14);

  // A number big enough to be an epoch is one, in seconds as Postgres gives it.
  const epoch = toChart([{ t: 1789000000, v: 1 }], "t", ["v"]);
  assert.equal(epoch.kind, "time");
  assert.equal(epoch.x[0], 1789000000 * 1000);
});

test("several series keep their own values", () => {
  const rows = [
    { time: "2026-09-12T10:00:00Z", min: 1, max: 9 },
    { time: "2026-09-12T11:00:00Z", min: 2, max: 8 },
  ];

  const chart = toChart(rows, "time", ["min", "max"]);

  assert.deepEqual(chart.series, [
    { name: "min", values: [1, 2] },
    { name: "max", values: [9, 8] },
  ]);
});

test("stacking shares of a moment adds up to a hundred", () => {
  const rows = [
    { time: "2026-09-12T10:00:00Z", a: 30, b: 10 },
    { time: "2026-09-12T11:00:00Z", a: 1, b: 3 },
  ];
  const shares = asPercentages(toChart(rows, "time", ["a", "b"]));

  assert.deepEqual(shares.series[0].values, [75, 25]);
  assert.deepEqual(shares.series[1].values, [25, 75]);
  // The x axis and the names are untouched.
  assert.deepEqual(
    shares.series.map((one) => one.name),
    ["a", "b"],
  );
});

test("a moment where everything is missing stays missing", () => {
  const rows = [
    { time: "2026-09-12T10:00:00Z", a: null, b: null },
    { time: "2026-09-12T11:00:00Z", a: null, b: 4 },
  ];
  const shares = asPercentages(toChart(rows, "time", ["a", "b"]));

  // Not a hundred per cent of nothing.
  assert.deepEqual(shares.series[0].values, [null, null]);
  assert.deepEqual(shares.series[1].values, [null, 100]);
});

test("a chart of labels can be put in order of its values", () => {
  const rows = [
    { room: "kitchen", rows: 10 },
    { room: "hall", rows: 30 },
    { room: "attic", rows: 20 },
  ];
  const chart = toChart(rows, "room", ["rows"]);

  assert.deepEqual(sortCategories(chart, "desc").x, ["hall", "attic", "kitchen"]);
  assert.deepEqual(sortCategories(chart, "asc").series[0].values, [10, 20, 30]);

  // A chart of times is already in the only order it has; sorting it would
  // draw something that never happened.
  const times = toChart(
    [
      { time: "2026-09-12T11:00:00Z", value: 1 },
      { time: "2026-09-12T10:00:00Z", value: 9 },
    ],
    "time",
    ["value"],
  );
  assert.deepEqual(sortCategories(times, "desc").series[0].values, times.series[0].values);
});
