/** What a query's rows become on a chart.
 *
 * The card hands whatever the database returned to these functions, so they
 * meet text where numbers were expected, nulls, unordered rows and columns
 * nobody can draw.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pickXColumn, pickYColumns, toChart } from "../.test/series.js";

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

  assert.equal(chart.xIsTime, true);
  assert.deepEqual(chart.series[0].values, [21, 22], "the unordered query is sorted");
  assert.ok(chart.x[0] < chart.x[1]);
  assert.equal(chart.x[0], Date.parse("2026-09-12T10:00:00Z") / 1000, "seconds, as uPlot wants");
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

test("a row whose x value makes no sense is dropped", () => {
  const rows = [
    { time: "not a date", value: 1 },
    { time: "2026-09-12T10:00:00Z", value: 2 },
  ];

  const chart = toChart(rows, "time", ["value"]);

  assert.equal(chart.x.length, 1);
  assert.deepEqual(chart.series[0].values, [2]);
});

test("a numeric x axis is left alone", () => {
  const rows = [
    { hour: 3, count: 10 },
    { hour: 1, count: 30 },
  ];

  const chart = toChart(rows, "hour", ["count"]);

  assert.equal(chart.xIsTime, false, "an hour number is not a timestamp");
  assert.deepEqual(chart.x, [1, 3]);
  assert.deepEqual(chart.series[0].values, [30, 10]);
});

test("epoch seconds and milliseconds both land on seconds", () => {
  const seconds = toChart([{ t: 1789000000, v: 1 }], "t", ["v"]);
  assert.equal(seconds.x[0], 1789000000);

  // A query selecting extract(epoch …) * 1000, which is easy to write by mistake.
  const millis = toChart([{ t: "2026-09-12T10:00:00Z", v: 1 }], "t", ["v"]);
  assert.equal(millis.x[0], Date.parse("2026-09-12T10:00:00Z") / 1000);
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
