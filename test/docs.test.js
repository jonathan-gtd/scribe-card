/** What the README says, against what the card does.
 *
 * The README drifted three times in one evening without a word from anything:
 * it announced three tabs when there were four, its picture of the editor
 * predated a whole tab, and it gave a weight the file had outgrown. Nobody
 * reads documentation closely enough to catch that; a test does.
 *
 * Deliberately not a picture comparison — the same page rendered on two
 * machines differs by a hair of font smoothing, and a check that cries wolf is
 * worse than none.
 */

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { editorTabs, LABELS } from "../.test/editor-schema.js";

const at = (name) => new URL(`../${name}`, import.meta.url);
const readme = readFileSync(at("README.md"), "utf8");
const types = readFileSync(at("src/types.ts"), "utf8");

/** The lines of the option tables, which is where an option is described. */
const rows = readme.split("\n").filter((line) => /^\|\s*`/.test(line));

/** Every option named in the first column of a table, combined rows included. */
const documented = new Set(
  rows.flatMap((row) =>
    [...(row.split("|")[1] ?? "").matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]),
  ),
);

/** Every option the card understands. */
const declared = new Set(
  [
    ...types
      .slice(types.indexOf("export interface ScribeCardConfig"))
      .matchAll(/^ {2}([a-z_0-9]+)\??:/gm),
  ].map((m) => m[1]),
);

test("every option the form offers is written down", () => {
  const missing = Object.keys(LABELS).filter((name) => !documented.has(name));
  assert.deepEqual(missing, [], `not in any table of the README: ${missing.join(", ")}`);
});

test("every option written down is one the card understands", () => {
  const unknown = [...documented].filter((name) => !declared.has(name) && name !== "type");
  assert.deepEqual(unknown, [], `documented but not in ScribeCardConfig: ${unknown.join(", ")}`);
});

test("the README counts the tabs it lists, and lists the tabs there are", () => {
  const COUNTS = ["no", "one", "two", "three", "four", "five", "six", "seven"];
  const line = readme.split("\n").find((one) => one.includes("tabs —"));
  assert.ok(line, "the README no longer says how the form is arranged");

  const listed = [...line.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
  const tabs = editorTabs().map((tab) => tab.label);
  assert.deepEqual(listed, tabs, "the tabs listed are not the tabs there are");
  assert.match(
    line,
    new RegExp(`\\b${COUNTS[tabs.length]}\\b`),
    `there are ${tabs.length} of them`,
  );
});

test("the weight the README gives is the weight of the file", () => {
  const claimed = /\*\*The card weighs (\d+) KB\*\* \((\d+) KB over the wire\)/.exec(readme);
  assert.ok(claimed, "the README no longer says what the card weighs");

  const real = Math.round(statSync(at("dist/scribe-card.js")).size / 1024);
  // A few kilobytes of slack: the point is to catch a claim that has fallen
  // behind a release or two, not to chase every commit.
  assert.ok(
    Math.abs(Number(claimed[1]) - real) <= 8,
    `the README says ${claimed[1]} KB and the file is ${real} KB`,
  );
});

test("the version being built is a version the changelog knows about", () => {
  const { version } = JSON.parse(readFileSync(at("package.json"), "utf8"));
  const changelog = readFileSync(at("CHANGELOG.md"), "utf8");
  // A release candidate is written up under the version it is a candidate for.
  const released = version.replace(/[-.]?rc.*$/, "");

  assert.match(
    changelog,
    new RegExp(`^## ${released.replace(/\./g, "\\.")}$`, "m"),
    `nothing in CHANGELOG.md about ${released}`,
  );
});
