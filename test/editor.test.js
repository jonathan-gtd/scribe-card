/** What the visual editor puts in the form, and what it writes back.
 *
 * An editor that saves every field it showed turns a two-line card into forty
 * lines of defaults, and one that forgets a field loses someone's work. Both
 * are checked here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanConfig, editorSchema, HELPERS, LABELS } from "../.test/editor-schema.js";

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
