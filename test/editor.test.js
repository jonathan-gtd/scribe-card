/** What the visual editor puts in the form, and what it writes back.
 *
 * An editor that saves every field it showed turns a two-line card into forty
 * lines of defaults, and one that forgets a field loses someone's work. Both
 * are checked here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanConfig, editorSchema, formData, HELPERS, LABELS } from "../.test/editor-schema.js";

function fields(schema) {
  return schema.flatMap((entry) => (entry.schema ? fields(entry.schema) : [entry]));
}

test("every field the form shows has a name a human reads", () => {
  for (const field of fields(editorSchema())) {
    assert.ok(LABELS[field.name], `${field.name} has no label`);
  }
});

test("the axes are free text until the query has run", () => {
  const before = fields(editorSchema()).find((f) => f.name === "x");
  assert.ok(before.selector.text, "nothing to choose from yet");

  const after = fields(editorSchema(["time", "average", "maximum"])).find((f) => f.name === "x");
  assert.deepEqual(
    after.selector.select.options.map((o) => o.value),
    ["time", "average", "maximum"],
    "the columns the query returned",
  );
  // A column the query does not return yet must still be typeable.
  assert.equal(after.selector.select.custom_value, true);
});

test("several columns can be drawn, one axis cannot", () => {
  const [x, y] = ["x", "y"].map((name) =>
    fields(editorSchema(["time", "a", "b"])).find((f) => f.name === name),
  );
  assert.equal(x.selector.select.multiple, false);
  assert.equal(y.selector.select.multiple, true);
});

test("the chart types offered are the ones the card draws", () => {
  const chart = fields(editorSchema()).find((f) => f.name === "chart");
  assert.deepEqual(
    chart.selector.select.options.map((o) => o.value),
    ["line", "area", "bar", "scatter"],
  );
});

test("the fields that need explaining have it", () => {
  for (const name of ["sql", "x", "y", "refresh_interval"]) {
    assert.ok(HELPERS[name], `${name} needs a line of help`);
  }
});

test("saving writes what was set, and nothing else", () => {
  const saved = cleanConfig({
    type: "custom:scribe-card",
    title: "Temperature",
    sql: "SELECT time, value FROM states",
    chart: "line", // the default
    unit: "",
    x: undefined,
    y: [],
    height: 250, // the default
    refresh_interval: 0, // the default
    zoom: true,
    stacked: false,
    fill: false,
    smooth: false,
  });

  assert.deepEqual(saved, {
    type: "custom:scribe-card",
    title: "Temperature",
    sql: "SELECT time, value FROM states",
    zoom: true,
  });
});

test("a single column is written as itself, not as a list of one", () => {
  assert.equal(cleanConfig({ sql: "…", y: ["value"] }).y, "value");
  assert.deepEqual(cleanConfig({ sql: "…", y: ["min", "max"] }).y, ["min", "max"]);
});

test("the card type is always there, even from an empty form", () => {
  assert.equal(cleanConfig({}).type, "custom:scribe-card");
});

test("the form is given what a field can hold, and the config keeps what it means", () => {
  // A legend has three answers — shown, hidden, and "when there are several" —
  // and a configuration has two of them plus absent.
  assert.equal(formData({}).legend, "auto");
  assert.equal(formData({ legend: true }).legend, "always");
  assert.equal(formData({ legend: false }).legend, "never");

  assert.equal(cleanConfig({ sql: "…", legend: "auto" }).legend, undefined, "auto is absent");
  assert.equal(cleanConfig({ sql: "…", legend: "always" }).legend, true);
  assert.equal(cleanConfig({ sql: "…", legend: "never" }).legend, false);

  // A single column is written as itself, and the field wants a list.
  assert.deepEqual(formData({ y: "value" }).y, ["value"]);
  assert.deepEqual(formData({ y: ["a", "b"] }).y, ["a", "b"]);
  assert.equal("y" in formData({}), false);

  // The CSV button is on by default, so the box has to be ticked to say so.
  assert.equal(formData({}).export, true);
  assert.equal(formData({ export: false }).export, false);
  assert.equal(
    cleanConfig({ sql: "…", export: true }).export,
    undefined,
    "a default is not written",
  );
  assert.equal(cleanConfig({ sql: "…", export: false }).export, false);
});

test("what goes through the form and back is what went in", () => {
  const config = {
    type: "custom:scribe-card",
    sql: "SELECT time_bucket($__interval, time) AS time, avg(value) FROM states WHERE time > $__from",
    title: "Temperature",
    unit: "°C",
    legend: false,
    y: "avg",
    ranges: ["24h", "7d"],
    colors: ["#0072b2"],
    storage_key: "kitchen",
    step: "end",
  };

  assert.deepEqual(cleanConfig(formData(config)), config);
});

test("the ranges and the colours are offered, not imposed", () => {
  const byName = Object.fromEntries(fields(editorSchema()).map((entry) => [entry.name, entry]));

  for (const name of ["ranges", "colors"]) {
    const select = byName[name].selector.select;
    assert.equal(select.multiple, true, `${name} takes several`);
    assert.equal(select.custom_value, true, `${name} takes one nobody listed`);
    assert.ok(select.options.length > 1);
  }
  // "24h" is a range anyone would want, and "1 day" is not one at all.
  assert.ok(byName.ranges.selector.select.options.some((option) => option.value === "24h"));
});

test("colours are picked, not typed in hexadecimal", () => {
  // Before the query has run there are no columns to name, so a list is all
  // there is to offer.
  const blind = fields(editorSchema()).find((one) => one.name === "colors");
  assert.ok(blind, "nothing offered for colours at all");

  // The columns the query returned are not the columns that get a colour:
  // `colors` runs in the order the series are drawn, and `time` is the axis.
  const known = fields(editorSchema(["time", "moyenne", "maximum"], ["moyenne", "maximum"]));
  // The per-column pickers, not every colour the form offers.
  const pickers = known.filter((one) => one.label?.startsWith("Colour of"));
  assert.equal(pickers.length, 2, "one picker per drawn series, not per column");
  assert.deepEqual(
    pickers.map((one) => one.label),
    ["Colour of moyenne", "Colour of maximum"],
  );
  assert.equal(
    known.some((one) => one.name === "colors"),
    false,
    "the hexadecimal list is still there beside the pickers",
  );
  // Knowing the columns is not enough; nothing is drawn until the rows say so.
  assert.ok(fields(editorSchema(["time", "moyenne"])).some((one) => one.name === "colors"));
});

test("what is picked lands in the list the card reads", () => {
  const columns = ["a", "b", "c"];

  // Out of the configuration and into the fields.
  assert.deepEqual(formData({ colors: ["red", "blue"] }, columns), {
    ...formData({ colors: ["red", "blue"] }, columns),
    color_0: "red",
    color_1: "blue",
    color_2: "",
  });

  // And back, in order.
  const saved = cleanConfig(
    { sql: "…", color_0: "red", color_1: "none", color_2: "blue" },
    columns,
  );
  assert.deepEqual(saved.colors, ["red", "", "blue"], "`none` is a slot left to the palette");

  // Nothing picked at all is no list, rather than a list of nothings.
  assert.equal(cleanConfig({ sql: "…", color_0: "", color_1: "" }, columns).colors, undefined);
  // And the fields themselves are never written to the configuration.
  assert.equal("color_0" in saved, false);
});

test("stacking is one question with three answers, not two that can disagree", () => {
  // `stacked` came first; a card written with it still reads correctly.
  assert.equal(formData({ stacked: true }).stack_mode, "total");
  assert.equal(formData({}).stack_mode, "off");
  assert.equal(formData({ stack_mode: "percent" }).stack_mode, "percent");
  assert.equal("stacked" in formData({ stacked: true }), false, "the old setting is not shown");

  // And saving writes the one setting, never both.
  const saved = cleanConfig({ sql: "…", stacked: true, stack_mode: "percent" });
  assert.equal(saved.stack_mode, "percent");
  assert.equal("stacked" in saved, false);
  assert.equal("stack_mode" in cleanConfig({ sql: "…", stack_mode: "off" }), false);
});
