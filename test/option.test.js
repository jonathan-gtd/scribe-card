/** The card's configuration, as an ECharts option.
 *
 * This is where a two-line card becomes a chart, and where someone who knows
 * ECharts can say anything ECharts allows. Both halves are checked here: the
 * sensible default, and the override winning over it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOption, merge, PALETTE, resolveFormatters } from "../.test/option.js";
import { toChart } from "../.test/series.js";

const THEME = { text: "#111", secondaryText: "#777", grid: "#ddd", background: "#fff" };

const TIME_ROWS = [
  { time: "2026-09-12T10:00:00Z", average: 21, maximum: 25 },
  { time: "2026-09-12T11:00:00Z", average: 22, maximum: 26 },
];

function option(rows, config = {}, x = "time") {
  const columns = Object.keys(rows[0]).filter((c) => c !== x);
  return buildOption(
    toChart(rows, x, columns),
    { type: "custom:scribe-card", sql: "…", ...config },
    THEME,
  );
}

test("a time column becomes a time axis, with pairs", () => {
  const built = option(TIME_ROWS);

  assert.equal(built.xAxis.type, "time");
  assert.equal(built.series.length, 2);
  assert.equal(built.series[0].type, "line");
  assert.deepEqual(built.series[0].data[0], [Date.parse("2026-09-12T10:00:00Z"), 21]);
});

test("a text column becomes a category axis, in the order the query returned", () => {
  const rows = [
    { entity_id: "sensor.b", rows: 30 },
    { entity_id: "sensor.a", rows: 10 },
  ];

  const built = option(rows, { chart: "bar" }, "entity_id");

  assert.equal(built.xAxis.type, "category");
  assert.deepEqual(built.xAxis.data, ["sensor.b", "sensor.a"], "an ORDER BY is not re-sorted");
  assert.equal(built.series[0].type, "bar");
  assert.deepEqual(built.series[0].data, [30, 10], "a category series is plain values");
});

test("area fills, and `fill` says the same thing", () => {
  assert.ok(option(TIME_ROWS, { chart: "area" }).series[0].areaStyle);
  assert.ok(option(TIME_ROWS, { fill: true }).series[0].areaStyle);
  assert.equal(option(TIME_ROWS).series[0].areaStyle, undefined);
});

test("stacking stacks every series", () => {
  const built = option(TIME_ROWS, { stacked: true });
  assert.deepEqual(
    built.series.map((s) => s.stack),
    ["total", "total"],
  );
});

test("the legend appears when there is something to tell apart", () => {
  assert.equal(option(TIME_ROWS).legend.show, true, "two series");
  assert.equal(option([{ time: "2026-09-12T10:00:00Z", v: 1 }]).legend.show, false, "one series");
  assert.equal(option(TIME_ROWS, { legend: false }).legend.show, false, "asked for");
});

test("colours follow the configuration, then the palette", () => {
  assert.equal(option(TIME_ROWS).series[0].itemStyle.color, PALETTE[0]);
  assert.equal(option(TIME_ROWS, { colors: ["#ff0000"] }).series[0].itemStyle.color, "#ff0000");
  // Fewer colours than series: the palette wraps rather than running out.
  assert.equal(option(TIME_ROWS, { colors: ["#ff0000"] }).series[1].itemStyle.color, "#ff0000");
});

test("a unit names the axis and follows the values in the tooltip", () => {
  const built = resolveFormatters(option(TIME_ROWS, { unit: "°C" }));

  assert.equal(built.yAxis.name, "°C");
  assert.equal(typeof built.tooltip.valueFormatter, "function");
  assert.equal(built.tooltip.valueFormatter(21.5), "21.5 °C");
  assert.equal(built.tooltip.valueFormatter(null), "—", "a gap is not 'null °C'");
});

test("zoom adds the two ECharts zooms and room for the slider", () => {
  const built = option(TIME_ROWS, { zoom: true });

  assert.deepEqual(
    built.dataZoom.map((z) => z.type),
    ["inside", "slider"],
  );
  assert.ok(built.grid.bottom > 8, "the slider needs the room");
  assert.equal(option(TIME_ROWS).dataZoom, undefined);
});

test("`options` is ECharts, and wins", () => {
  const built = option(TIME_ROWS, {
    unit: "°C",
    options: { yAxis: { min: 0, max: 40 }, tooltip: { trigger: "item" }, backgroundColor: "#000" },
  });

  assert.equal(built.yAxis.min, 0, "what the user added");
  assert.equal(built.yAxis.name, "°C", "what the card built, still there");
  assert.equal(built.tooltip.trigger, "item", "overridden, not merged into nonsense");
  assert.equal(built.backgroundColor, "#000");
});

test("`series` is ECharts too, by column name", () => {
  const built = option(TIME_ROWS, {
    series: { maximum: { lineStyle: { type: "dashed", width: 4 }, z: 5 } },
  });

  const [average, maximum] = built.series;
  assert.equal(maximum.lineStyle.type, "dashed");
  assert.equal(maximum.lineStyle.width, 4);
  assert.equal(maximum.lineStyle.color, PALETTE[1], "the colour survives the override");
  assert.equal(maximum.z, 5);
  assert.equal(average.lineStyle.width, 2, "the other series is untouched");
});

test("merge replaces values and descends into objects", () => {
  assert.deepEqual(merge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 }, e: 4 }), {
    a: 1,
    b: { c: 9, d: 3 },
    e: 4,
  });
  // An array is a value: merging two arrays element by element is never what
  // anyone means.
  assert.deepEqual(merge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
  assert.deepEqual(merge({ a: 1 }, undefined), { a: 1 });
});
