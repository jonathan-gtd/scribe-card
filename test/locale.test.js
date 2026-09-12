/** Home Assistant's dates and numbers, turned into what ECharts wants.
 *
 * The mappings here are Home Assistant's own — a number format names a
 * convention rather than a language, and `system` means the browser's — so
 * these check that the card reads them the way the frontend does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  echartsLocale,
  numberFormatter,
  numberLocales,
  timeLevels,
  usesAmPm,
} from "../.test/locale.js";

test("a number format names a convention, not a language", () => {
  // What the frontend itself maps them to.
  assert.deepEqual(numberLocales({ number_format: "comma_decimal" }), ["en-US", "en"]);
  assert.deepEqual(numberLocales({ number_format: "space_comma" }), ["fr", "sv", "cs"]);
  assert.deepEqual(numberLocales({ number_format: "quote_decimal" }), ["de-CH"]);
  // `system` is the browser's own setting, which is `Intl`'s default.
  assert.equal(numberLocales({ number_format: "system" }), undefined);
  // Anything else follows the language the dashboard is in.
  assert.deepEqual(numberLocales({ language: "fr", number_format: "language" }), ["fr"]);
  assert.equal(numberLocales(undefined), undefined);
});

test("numbers are written the way the dashboard writes them", () => {
  assert.match(numberFormatter({ number_format: "space_comma" })(1234.5), /^1.234,5$/);
  assert.equal(numberFormatter({ number_format: "comma_decimal" })(1234.5), "1,234.5");

  // `none` hands back the digits the query returned, untouched.
  assert.equal(numberFormatter({ number_format: "none" })(1234.5), "1234.5");

  const format = numberFormatter({ language: "en" });
  assert.equal(format(null), "", "a gap is not a zero");
  assert.equal(format(undefined), "");
  // A column that is not a number at all still has to come back as something.
  assert.equal(format("on"), "on");
  assert.equal(format(Infinity), "Infinity");
  // Three decimals is where a chart label stops being read.
  assert.equal(format(1 / 3), "0.333");
});

test("the clock is the one the dashboard is set to", () => {
  assert.equal(usesAmPm({ time_format: "am_pm" }), true);
  assert.equal(usesAmPm({ time_format: "twenty_four" }), false);
  // `language` asks the language: English is on twelve hours, French is not.
  assert.equal(usesAmPm({ time_format: "language", language: "en-US" }), true);
  assert.equal(usesAmPm({ time_format: "language", language: "fr" }), false);
  // `system`, and a card handed no locale at all, follow the machine — which is
  // French here and American on a runner, so only the shape can be asserted.
  assert.equal(typeof usesAmPm({ time_format: "system" }), "boolean");
  assert.equal(typeof usesAmPm(undefined), "boolean");
});

test("the time axis keeps its levels, and changes only its clock", () => {
  const twelve = timeLevels(true);
  const twentyFour = timeLevels(false);

  assert.equal(twelve.hour, "{h}:{mm} {A}");
  assert.equal(twentyFour.hour, "{HH}:{mm}");
  // The levels are what keeps a zoomed axis readable; both keep all of them.
  assert.deepEqual(Object.keys(twelve), Object.keys(twentyFour));
  assert.equal(twelve.year, twentyFour.year, "a year is a year in either clock");
});

test("the month and weekday names come from the language, not a locale pack", () => {
  const french = echartsLocale("fr");

  assert.equal(french.time.month.length, 12);
  assert.equal(french.time.month[0], "janvier");
  assert.equal(french.time.dayOfWeek.length, 7);
  // ECharts counts from Sunday, which is what `getDay()` returns 0 for.
  assert.equal(french.time.dayOfWeek[0], "dimanche");
  assert.equal(french.time.dayOfWeek[1], "lundi");

  const german = echartsLocale("de");
  assert.equal(german.time.month[0], "Januar");

  // A language nobody has does not throw; it falls back to the environment.
  assert.equal(echartsLocale("zz-ZZ").time.month.length, 12);
});
