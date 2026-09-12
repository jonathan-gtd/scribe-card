/** The window of time a card is looking at.
 *
 * Everything here ends up inside a SQL query, so the rules that keep it safe —
 * a duration is digits and one letter, and nothing else becomes SQL — are the
 * ones worth pinning down.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bucketFor,
  hasMarkers,
  isRange,
  labelFor,
  parseDuration,
  resolve,
  substitute,
} from "../.test/range.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

test("a duration is digits and one unit, or it is not a duration", () => {
  assert.equal(parseDuration("24h"), 24 * HOUR);
  assert.equal(parseDuration("7d"), 7 * DAY);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.equal(parseDuration(" 1w "), 7 * DAY);

  // Anything that is not one goes no further, which is what keeps it out of
  // the SQL: this is the only door.
  for (const bad of [
    "1 day",
    "24 h",
    "0h",
    "-1d",
    "1h; DROP TABLE states",
    "h",
    "",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(parseDuration(bad), null, `${JSON.stringify(bad)} is not a duration`);
  }
});

test("a remembered range is checked before it is believed", () => {
  assert.equal(isRange({ last: "7d" }), true);
  assert.equal(isRange({ from: 1, to: 2 }), true);

  // What could come back from a store someone else has written to.
  assert.equal(isRange({ last: "everything" }), false);
  assert.equal(isRange({ from: 2, to: 1 }), false, "an end before its beginning");
  assert.equal(isRange({ from: "a", to: "b" }), false);
  assert.equal(isRange({}), false);
  assert.equal(isRange(null), false);
  assert.equal(isRange("7d"), false);
});

test("the bucket keeps a range to a few hundred points", () => {
  const points = (span, interval) => {
    const widths = {
      "1 minute": 60_000,
      "5 minutes": 300_000,
      "15 minutes": 900_000,
      "30 minutes": 1_800_000,
      "1 hour": HOUR,
      "3 hours": 3 * HOUR,
      "6 hours": 6 * HOUR,
      "12 hours": 12 * HOUR,
      "1 day": DAY,
      "1 week": 7 * DAY,
    };
    return span / widths[interval];
  };

  for (const span of [HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY, 365 * DAY]) {
    const interval = bucketFor(span);
    assert.ok(points(span, interval) <= 400, `${interval} leaves too many points`);
  }

  // The finest that fits, not the coarsest that would.
  assert.equal(bucketFor(HOUR), "1 minute");
  assert.equal(bucketFor(DAY), "5 minutes");
  // Nothing above a week: time_bucket() wants a fixed width, and a month is not.
  assert.equal(bucketFor(3650 * DAY), "1 week");
});

test("a query says whether it has anything for a range to fill", () => {
  assert.equal(hasMarkers("SELECT 1 WHERE time > $__from"), true);
  assert.equal(hasMarkers("SELECT time_bucket($__interval, time)"), true);
  assert.equal(hasMarkers("SELECT 1 WHERE time > now() - interval '1 day'"), false);
  // A column that merely starts the same way is not a marker.
  assert.equal(hasMarkers("SELECT $__fromage"), false);
});

test("the range is written into the query as fixed instants", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const sql = substitute(
    "SELECT time_bucket($__interval, time) FROM states WHERE time >= $__from AND time < $__to",
    { last: "24h" },
    now,
  );

  assert.match(sql, /time_bucket\('5 minutes', time\)/);
  assert.match(sql, />= '2026-09-11T12:00:00\.000Z'::timestamptz/);
  assert.match(sql, /< '2026-09-12T12:00:00\.000Z'::timestamptz/);
  assert.equal(sql.includes("$__"), false, "a marker was left behind");
});

test("every mention of an instant is the same instant", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  // `now()` twice in one query can straddle a second; a written instant cannot.
  const sql = substitute("$__from $__from $__to $__interval $__interval", { last: "7d" }, now);
  const [a, b] = sql.split(" ");
  assert.equal(a, b);
});

test("an absolute range is two instants, kept as they are", () => {
  const from = Date.parse("2026-01-01T00:00:00.000Z");
  const to = Date.parse("2026-01-02T00:00:00.000Z");
  assert.deepEqual(resolve({ from, to }, Date.now()), { from, to });

  const sql = substitute("$__from..$__to", { from, to }, Date.now());
  assert.equal(
    sql,
    "'2026-01-01T00:00:00.000Z'::timestamptz..'2026-01-02T00:00:00.000Z'::timestamptz",
  );
});

test("a query with no markers comes back untouched", () => {
  const sql = "SELECT time, value FROM states ORDER BY time";
  assert.equal(substitute(sql, { last: "24h" }, Date.now()), sql);
});

test("the picker says what it is showing", () => {
  assert.equal(labelFor({ last: "24h" }), "Last 24 hours");
  assert.equal(labelFor({ last: "1h" }), "Last hour", "one of something is not '1 hours'");
  assert.equal(labelFor({ last: "7d" }), "Last 7 days");
  assert.equal(labelFor({ last: "1y" }), "Last year");

  const label = labelFor(
    { from: Date.parse("2026-01-01T10:00:00Z"), to: Date.parse("2026-01-02T10:00:00Z") },
    { language: "en-GB", time_format: "twenty_four" },
  );
  assert.match(label, /—/, "two instants are shown as a span");
  assert.match(label, /01\/01\/2026/);
});
