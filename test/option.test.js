/** The card's configuration, as an ECharts option.
 *
 * This is where a two-line card becomes a chart, and where someone who knows
 * ECharts can say anything ECharts allows. Both halves are checked here: the
 * sensible default, and the override winning over it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PALETTE, buildOption, merge, resolveColour, resolveFormatters } from "../.test/option.js";
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
  const built = resolveFormatters(option(TIME_ROWS, { unit: "°C" }), { language: "en" });

  assert.equal(built.yAxis.name, "°C");
  assert.equal(typeof built.tooltip.valueFormatter, "function");
  assert.equal(built.tooltip.valueFormatter(21.5), "21.5 °C");
  assert.equal(built.tooltip.valueFormatter(null), "—", "a gap is not 'null °C'");
  // No unit: the number still comes back, without a trailing space.
  const plain = resolveFormatters(option(TIME_ROWS), { language: "en" });
  assert.equal(plain.tooltip.valueFormatter(21.5), "21.5");
});

test("the values are written the way the dashboard writes numbers", () => {
  const french = resolveFormatters(option(TIME_ROWS, { unit: "°C" }), {
    language: "fr",
    number_format: "space_comma",
  });
  // 1234.5 is "1 234,5" in French, with a non-breaking space for the thousands.
  assert.match(french.tooltip.valueFormatter(1234.5), /^1.234,5 °C$/);
  assert.match(french.yAxis.axisLabel.formatter(1234.5), /^1.234,5$/);

  // `none` is someone asking for the digits they wrote, untouched.
  const raw = resolveFormatters(option(TIME_ROWS), { number_format: "none" });
  assert.equal(raw.yAxis.axisLabel.formatter(1234.5), "1234.5");
});

test("a time axis is labelled on the dashboard's clock", () => {
  const twelve = resolveFormatters(option(TIME_ROWS), { time_format: "am_pm" });
  const twenty_four = resolveFormatters(option(TIME_ROWS), { time_format: "twenty_four" });

  // ECharts' leveled labels: an object per zoom level, not a function.
  assert.equal(twelve.xAxis.axisLabel.formatter.hour, "{h}:{mm} {A}");
  assert.equal(twenty_four.xAxis.axisLabel.formatter.hour, "{HH}:{mm}");
  assert.equal(twenty_four.xAxis.axisLabel.formatter.year, "{yyyy}");
});

test("a category axis has no clock to label", () => {
  const rows = [
    { entity_id: "sensor.b", rows: 30 },
    { entity_id: "sensor.a", rows: 10 },
  ];
  const built = resolveFormatters(option(rows, { chart: "bar" }, "entity_id"), { language: "en" });
  assert.equal(built.xAxis.type, "category");
  assert.equal(built.xAxis.axisLabel.formatter, undefined);
});

test("an axis the configuration replaced keeps what it was given", () => {
  // `options:` wins, and a user who wrote their own axes owns their labels.
  const built = resolveFormatters(
    option(TIME_ROWS, { options: { yAxis: [{ name: "°C" }, { name: "%" }] } }),
    { language: "en" },
  );
  assert.deepEqual(
    built.yAxis.map((axis) => axis.name),
    ["°C", "%"],
  );
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

test("a second axis exists only when something is drawn against it", () => {
  assert.equal(Array.isArray(option(TIME_ROWS).yAxis), false, "one axis, as before");

  const built = option(TIME_ROWS, { y2: "maximum", unit: "°C", y2_unit: "%" });
  assert.equal(built.yAxis.length, 2);
  assert.equal(built.yAxis[1].position, "right");
  assert.equal(built.series[0].yAxisIndex, undefined, "average stayed on the left");
  assert.equal(built.series[1].yAxisIndex, 1, "maximum went to the right");

  // Two sets of horizontal lines at different heights is a mess.
  assert.equal(built.yAxis[1].splitLine.show, false);
});

test("each axis writes its own unit into the tooltip", () => {
  const built = resolveFormatters(option(TIME_ROWS, { y2: "maximum", unit: "°C", y2_unit: "%" }), {
    language: "en",
  });

  assert.equal(built.tooltip.valueFormatter(21.5), "21.5 °C", "the left axis's unit");
  assert.equal(built.series[1].tooltip.valueFormatter(60), "60 %", "the right axis's own");
});

test("an axis can be told where to start, stop and how to step", () => {
  const built = option(TIME_ROWS, { y_min: 0, y_max: 40, y_log: true, y_name: "Degrees" });

  assert.equal(built.yAxis.min, 0, "zero is a minimum, not an absence of one");
  assert.equal(built.yAxis.max, 40);
  assert.equal(built.yAxis.type, "log");
  assert.equal(built.yAxis.name, "Degrees", "the name wins over the unit");
  // Left alone, the axis fits the values.
  assert.equal(option(TIME_ROWS).yAxis.min, undefined);
});

test("decimals reach the axis and the tooltip", () => {
  const built = resolveFormatters(option(TIME_ROWS, { unit: "°C", decimals: 1 }), {
    language: "en",
  });

  assert.equal(built.tooltip.valueFormatter(21.4567), "21.5 °C");
  assert.equal(built.yAxis.axisLabel.formatter(21.4567), "21.5");
  // Without it, the value is written as it came.
  const plain = resolveFormatters(option(TIME_ROWS), { language: "en" });
  assert.equal(plain.yAxis.axisLabel.formatter(21.4567), "21.457");
});

test("the x axis can be named, turned, and its lines turned off", () => {
  const built = option(TIME_ROWS, { x_name: "When", x_rotate: 45, split_lines: false });

  assert.equal(built.xAxis.name, "When");
  assert.equal(built.xAxis.axisLabel.rotate, 45);
  assert.equal(built.yAxis.splitLine.show, false);
  assert.equal(option(TIME_ROWS).yAxis.splitLine.show, true, "lines are drawn by default");
});

test("the room around the chart can be given away", () => {
  const built = option(TIME_ROWS, { margin_left: 40, margin_bottom: 30 });

  assert.equal(built.grid.left, 40);
  assert.equal(built.grid.bottom, 30);
  assert.equal(built.grid.right, 12, "what was not asked for is unchanged");
  // A zoomable chart needs room for its slider, unless it was told otherwise.
  assert.equal(option(TIME_ROWS, { zoom: true }).grid.bottom, 28);
  assert.equal(option(TIME_ROWS, { zoom: true, margin_bottom: 60 }).grid.bottom, 60);
});

test("the line can be given a thickness, a fill and marks on its points", () => {
  const built = option(TIME_ROWS, {
    fill: true,
    line_width: 4,
    opacity: 0.5,
    symbol: "diamond",
    symbol_size: 9,
  });

  assert.equal(built.series[0].lineStyle.width, 4);
  assert.equal(built.series[0].areaStyle.opacity, 0.5);
  assert.equal(built.series[0].symbol, "diamond");
  assert.equal(built.series[0].symbolSize, 9);
  assert.equal(built.series[0].showSymbol, true, "asking for a symbol is asking to see it");
  // None of which happens unless it is asked for.
  assert.equal(option(TIME_ROWS).series[0].showSymbol, false);
  assert.equal(option(TIME_ROWS).series[0].lineStyle.width, 2);
});

test("a fade is a gradient, not a fainter wash", () => {
  const flat = option(TIME_ROWS, { fill: true }).series[0].areaStyle;
  const faded = option(TIME_ROWS, { fill: true, gradient: true }).series[0].areaStyle;

  assert.equal(typeof flat.color, "string", "a plain fill is one colour");
  assert.equal(faded.color.type, "linear");
  assert.equal(faded.color.colorStops.at(-1).color, "transparent", "it fades to nothing");
  // A gradient carries its own fading; fading it again would double it.
  assert.ok(faded.opacity > flat.opacity);
});

test("lines across the chart are drawn once, not once per series", () => {
  const built = option(TIME_ROWS, { mark_average: true, threshold: 30, threshold_name: "Limit" });

  const marks = built.series[0].markLine.data;
  assert.deepEqual(
    marks.map((one) => one.type ?? one.yAxis),
    ["average", 30],
  );
  assert.equal(marks[1].name, "Limit");
  // Four series would otherwise be four averages and four limits.
  assert.equal(built.series[1].markLine, undefined);
  assert.equal(option(TIME_ROWS).series[0].markLine, undefined, "none unless asked for");
});

test("the legend can be moved, and the tooltip silenced", () => {
  assert.equal(option(TIME_ROWS).legend.top, 0, "above, as before");

  const right = option(TIME_ROWS, { legend_position: "right" }).legend;
  assert.equal(right.right, 0);
  assert.equal(right.orient, "vertical", "beside the chart it has to run downwards");

  assert.equal(option(TIME_ROWS, { tooltip_trigger: "item" }).tooltip.trigger, "item");
  assert.equal(option(TIME_ROWS, { tooltip_trigger: "none" }).tooltip.show, false);
});

test("values can be written beside the points, in the dashboard's own numbers", () => {
  const built = resolveFormatters(option(TIME_ROWS, { labels: true, unit: "°C", decimals: 1 }), {
    language: "en",
  });

  assert.equal(built.series[0].label.show, true);
  assert.equal(built.series[0].label.formatter(21.46), "21.5 °C");
  assert.equal(option(TIME_ROWS).series[0].label, undefined);
});

test("a chart that refreshes does not dance each time", () => {
  assert.equal(option(TIME_ROWS).animation, false);
  assert.equal(option(TIME_ROWS, { animation: true }).animation, true);
});

test("naming a column that is not drawn does not raise an axis for it", () => {
  // A typo, or a column a rewritten query no longer returns.
  const built = option(TIME_ROWS, { y2: "humidity" });
  assert.equal(Array.isArray(built.yAxis), false, "an axis was raised for nothing");
  assert.equal(
    built.series.every((one) => one.yAxisIndex === undefined),
    true,
  );
});

test("a chart of shares is labelled as shares", () => {
  const built = resolveFormatters(
    option(TIME_ROWS, { stack_mode: "percent", unit: "°C", y2: "maximum", y2_unit: "n" }),
    { language: "en" },
  );

  assert.equal(built.yAxis[0].name, "%", "the axis still claimed degrees");
  assert.equal(built.yAxis[0].min, 0);
  assert.equal(built.yAxis[0].max, 100);
  assert.equal(built.tooltip.valueFormatter(75), "75 %");
  // The other axis is not a share of anything, so it keeps its own unit.
  assert.equal(built.yAxis[1].name, "n");
  assert.equal(built.series[1].tooltip.valueFormatter(12), "12 n");
  // And what the configuration says still wins.
  assert.equal(option(TIME_ROWS, { stack_mode: "percent", y_max: 50 }).yAxis.max, 50);
});

test("asking for shares is asking to stack them", () => {
  // The two settings could disagree; only one answer comes out.
  assert.equal(option(TIME_ROWS, { stack_mode: "percent" }).series[0].stack, "total");
  assert.equal(option(TIME_ROWS, { stacked: true }).series[0].stack, "total");
  assert.equal(option(TIME_ROWS).series[0].stack, undefined);
  // A stacked line is filled, whichever setting asked for the stacking.
  assert.ok(option(TIME_ROWS, { stack_mode: "total" }).series[0].areaStyle);
});

test("a line across the chart is drawn against the axis it belongs to", () => {
  // The first column is on the right; an average drawn there would be an
  // average of something else.
  const built = option(TIME_ROWS, { y2: "average", mark_average: true });

  assert.equal(built.series[0].name, "average");
  assert.equal(built.series[0].markLine, undefined, "the marks went to the right-hand axis");
  assert.equal(built.series[1].name, "maximum");
  assert.equal(built.series[1].markLine.data[0].type, "average");
});

test("a colour Home Assistant has a name for follows the theme", () => {
  const theme = (name) => ({ red: "#f44336", primary: "#03a9f4" })[name] ?? "";

  assert.equal(resolveColour("red", theme), "#f44336");
  assert.equal(resolveColour("primary", theme), "#03a9f4");
  // Anything already written as a colour is left alone.
  assert.equal(resolveColour("#0072b2", theme), "#0072b2");
  assert.equal(resolveColour("rgb(1,2,3)", theme), "rgb(1,2,3)");
  // A name nothing answers for is handed over rather than dropped.
  assert.equal(resolveColour("chartreuse", theme), "chartreuse");
  assert.equal(resolveColour("red", undefined), "red", "no theme to ask");
  assert.equal(resolveColour(""), "");
});

test("the series take their colour through the theme", () => {
  const built = buildOption(
    toChart(TIME_ROWS, "time", ["average"]),
    { type: "custom:scribe-card", sql: "…", colors: ["red"] },
    { ...THEME, colour: (name) => (name === "red" ? "#f44336" : "") },
  );

  assert.equal(built.series[0].itemStyle.color, "#f44336");
  assert.equal(built.series[0].lineStyle.color, "#f44336");
});
