/** The card, in a real Home Assistant.
 *
 * What `scripts/smoke.js` cannot reach: a real `callService` and the shape it
 * rejects with, a real `ha-form` in the editor, a real French instance, a real
 * `frontend/set_user_data` surviving a reload. Every bug that got past the
 * browser checks and reached a live dashboard was one of those.
 *
 *     npm run e2e            bring it up, check, tear it down
 *     E2E_KEEP=1 npm run e2e leave it standing to look at
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { BASE_URL, cleanup, hassTokens, haLog, seed, sql, up } from "./rig.js";

function chromiumPath() {
  const base = resolve(process.env.HOME ?? "", ".cache/ms-playwright");
  const builds = existsSync(base)
    ? readdirSync(base)
        .filter((name) => name.startsWith("chromium-"))
        .map((name) => resolve(base, name, "chrome-linux64/chrome"))
        .filter((path) => existsSync(path))
    : [];
  return builds.sort().at(-1);
}

const RANGED_SQL = `SELECT time_bucket($__interval, time) AS time, avg(value) AS moyenne
FROM states WHERE entity_id = 'sensor.e2e_temperature'
  AND time >= $__from AND time < $__to
GROUP BY 1 ORDER BY 1`;

/** The dashboard the checks are run against. */
const DASHBOARD = {
  views: [
    {
      title: "Cards",
      cards: [
        {
          type: "custom:scribe-card",
          title: "Plain",
          unit: "°C",
          height: 200,
          sql: `SELECT time_bucket('1 hour', time) AS time, avg(value) AS moyenne
                FROM states WHERE entity_id = 'sensor.e2e_temperature'
                  AND time > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
        },
        {
          type: "custom:scribe-card",
          title: "Ranged",
          unit: "°C",
          height: 200,
          ranges: ["24h", "7d", "30d"],
          storage_key: "e2e",
          sql: RANGED_SQL,
        },
        {
          type: "custom:scribe-card",
          title: "Broken",
          sql: "SELECT * FROM a_table_that_is_not_there",
        },
        {
          type: "custom:scribe-card",
          title: "Two axes",
          unit: "°C",
          height: 200,
          y2: "releves",
          y2_unit: "n",
          y_name: "Degrés",
          y_min: 0,
          decimals: 1,
          sql: `SELECT time_bucket('1 hour', time) AS time, avg(value) AS moyenne,
                       count(*) AS releves
                FROM states WHERE entity_id = 'sensor.e2e_temperature'
                  AND time > now() - interval '48 hours' GROUP BY 1 ORDER BY 1`,
        },
        {
          type: "custom:scribe-card",
          title: "Shares",
          unit: "°C",
          height: 200,
          chart: "bar",
          stack_mode: "percent",
          y2: "releves",
          y2_unit: "n",
          colors: ["red", "blue"],
          sql: `SELECT time_bucket('6 hours', time) AS time,
                       avg(value) AS chaud, avg(value) / 2 AS froid, count(*) AS releves
                FROM states WHERE entity_id = 'sensor.e2e_temperature'
                  AND time > now() - interval '48 hours' GROUP BY 1 ORDER BY 1`,
        },
      ],
    },
    {
      title: "Sections",
      type: "sections",
      sections: [
        {
          type: "grid",
          cards: [
            {
              type: "custom:scribe-card",
              title: "In a section",
              height: 250,
              sql: "SELECT time, value FROM states WHERE entity_id = 'sensor.e2e_temperature' LIMIT 50",
            },
          ],
        },
      ],
    },
  ],
};

const checks = [];
async function check(name, body) {
  try {
    await body();
    checks.push([true, name]);
  } catch (error) {
    checks.push([false, name, error]);
  }
}

/**
 * The card with a given title.
 *
 * By title and not by position: a check that counts cards breaks the moment
 * one is added, and breaks somewhere else entirely.
 */
async function card(page, title) {
  const all = page.locator("scribe-card");
  const found = [];
  for (let index = 0; index < (await all.count()); index++) {
    const one = all.nth(index);
    const its = await one.evaluate((element) => element._config?.title);
    if (its === title) return one;
    found.push(its);
  }
  throw new Error(`no card titled ${title}; the page has ${JSON.stringify(found)}`);
}

const DASHBOARD_URL = `${BASE_URL}/e2e-cards`;

const rig = await up();
console.log(`  ${await seed()} rows of history`);

const browser = await chromium.launch({ executablePath: chromiumPath() });
// The frontend takes its language from the browser unless a profile says
// otherwise, so the browser is told rather than asked: a runner in English
// would quietly check nothing here.
const page = await browser.newPage({
  viewport: { width: 1100, height: 900 },
  locale: "fr-FR",
  timezoneId: "Europe/Paris",
});

/**
 * What the browser complained about once the card was on screen.
 *
 * Before that there is no card: its resource is not registered yet, so its
 * code has not even been fetched, and a freshly onboarded Home Assistant
 * complains about one or two things of its own on the way up. Those are kept
 * apart and printed, so nothing is silently swallowed — but they are not this
 * suite's to answer for.
 */
let phase = "start";
const problems = [];
const notOurs = [];
const complaint = (text) => (phase === "checks" ? problems : notOurs).push(text);

page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (/favicon|manifest|Failed to load resource/.test(text)) return;
  complaint(text);
});
/** Whatever the page threw, readable. A page can reject with anything, and
 * `String()` on a plain object says "Object" — which is how the card came to
 * show "[object Object]" on a live dashboard. */
function describe(thrown) {
  if (thrown instanceof Error) {
    const where = (thrown.stack ?? "").split("\n").slice(0, 3).join(" | ");
    return `${thrown.name}: ${thrown.message || "(no message)"} — ${where}`;
  }
  if (thrown && typeof thrown === "object") {
    const { message, code } = thrown;
    if (typeof message === "string" && message) return code ? `${code}: ${message}` : message;
    try {
      return JSON.stringify(thrown);
    } catch {
      // Nothing readable in it.
    }
  }
  return String(thrown);
}

page.on("pageerror", (error) => complaint(`${describe(error)} [at ${page.url()}]`));

await page.addInitScript(
  (tokens) => localStorage.setItem("hassTokens", JSON.stringify(tokens)),
  hassTokens(rig.tokens),
);

// A promise rejected with something that is not an Error reaches Playwright as
// a bare "Object" and says nothing. Caught here instead, where its contents
// can still be read.
await page.addInitScript(() => {
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    let described;
    try {
      described =
        reason instanceof Error
          ? `${reason.message} | ${(reason.stack ?? "").split("\n")[1] ?? ""}`
          : JSON.stringify(reason);
    } catch {
      described = String(reason);
    }
    // eslint-disable-next-line no-console
    console.error(`unhandled rejection: ${described}`);
  });
});

phase = "first load";
await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("home-assistant")?.hass?.services, null, {
  timeout: 60_000,
});

phase = "setup";
// The card, and a dashboard to put it on — through the frontend's own
// connection, which is the API Home Assistant actually offers. A dashboard of
// its own, because the landing page is no longer a Lovelace one.
await page.evaluate(async (config) => {
  const hass = document.querySelector("home-assistant").hass;
  // The profile language, as the profile page itself saves it.
  await hass.callWS({
    type: "frontend/set_user_data",
    key: "language",
    value: { language: "fr" },
  });
  await hass.callWS({
    type: "lovelace/resources/create",
    res_type: "module",
    url: "/local/scribe-card.js?v=e2e",
  });
  await hass.callWS({
    type: "lovelace/dashboards/create",
    url_path: "e2e-cards",
    title: "E2E",
    mode: "storage",
    show_in_sidebar: true,
    require_admin: false,
  });
  await hass.callWS({ type: "lovelace/config/save", url_path: "e2e-cards", config });
}, DASHBOARD);

phase = "dashboard";
// A resource is fetched when the page loads, so the card only exists after one.
await page.goto(`${DASHBOARD_URL}/0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => customElements.get("scribe-card") !== undefined, null, {
  timeout: 30_000,
});
await page.locator("scribe-card").first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);

phase = "checks";
await check("the card draws what the database returned", async () => {
  const drawn = await (
    await card(page, "Plain")
  ).evaluate((element) => ({
    canvas: Boolean(element.shadowRoot.querySelector(".chart canvas")),
    label: element.shadowRoot.querySelector(".chart")?.getAttribute("aria-label"),
    rows: element.shadowRoot.querySelectorAll("table tbody tr").length,
  }));
  assert.equal(drawn.canvas, true, "no chart was drawn");
  assert.match(drawn.label, /A line chart of moyenne, over \d+ points/);
  assert.ok(drawn.rows > 0, "the hidden table for a screen reader is empty");
});

await check("a query that fails says what the database said", async () => {
  const shown = await (
    await card(page, "Broken")
  ).evaluate((element) => ({
    error: Boolean(element.shadowRoot.querySelector(".error")),
    text: element.shadowRoot.textContent.replace(/\s+/g, " ").trim(),
  }));
  assert.equal(shown.error, true, "a broken query drew no error at all");
  // The bug that reached a live dashboard: Home Assistant rejects with
  // {code, message}, and String() on that says "[object Object]".
  assert.doesNotMatch(shown.text, /\[object Object\]/, "the card described the error object");
  assert.match(shown.text, /a_table_that_is_not_there|does not exist/);
});

await check("the axis is written in the language the instance is in", async () => {
  const locale = await page.evaluate(() => document.querySelector("home-assistant").hass.locale);
  assert.equal(locale.language, "fr", `the instance is in ${locale.language}, not French`);

  // ECharts draws to a canvas, so the proof is in the option it was given.
  const labels = await (
    await card(page, "Plain")
  ).evaluate((element) => {
    const option = element._chart.getOption();
    const formatter = option.xAxis[0].axisLabel.formatter;
    return {
      hour: formatter.hour,
      month: formatter.month,
      y: typeof option.yAxis[0].axisLabel.formatter,
    };
  });
  assert.equal(labels.hour, "{HH}:{mm}", "a French dashboard got a twelve-hour clock");
  assert.equal(labels.y, "function", "numbers are not being formatted at all");
});

await check("a range can be chosen, and the query follows it", async () => {
  const ranged = await card(page, "Ranged");
  await ranged.locator(".trigger").click();
  await page.waitForTimeout(200);
  await ranged.locator(".choice", { hasText: "Last 30 days" }).click();
  await page.waitForTimeout(2500);

  const after = await ranged.evaluate((element) => ({
    label: element.shadowRoot.querySelector(".trigger span")?.textContent.trim(),
    points: element.shadowRoot.querySelector(".chart")?.getAttribute("aria-label"),
    canvas: Boolean(element.shadowRoot.querySelector(".chart canvas")),
  }));
  assert.equal(after.label, "Last 30 days");
  assert.equal(after.canvas, true, "the chart went away when the range changed");
  assert.match(after.points, /over \d+ points/);
});

await check("the chosen range outlives a reload, from the user store", async () => {
  // What the browser remembers is easy; this proves the server was told.
  const stored = await page.evaluate(async () => {
    const hass = document.querySelector("home-assistant").hass;
    const { value } = await hass.callWS({ type: "frontend/get_user_data", key: "scribe-card.e2e" });
    return value;
  });
  assert.deepEqual(stored, { last: "30d" }, "Home Assistant was never told");

  await page.evaluate(() => localStorage.removeItem("scribe-card.e2e"));
  await page.goto(`${DASHBOARD_URL}/0`, { waitUntil: "domcontentloaded" });
  await page.locator("scribe-card").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);

  const label = await (
    await card(page, "Ranged")
  ).evaluate((element) => element.shadowRoot.querySelector(".trigger span")?.textContent.trim());
  assert.equal(label, "Last 30 days", "the card forgot, with only the server to ask");
});

await check("the editor finds the columns of a query with a range in it", async () => {
  const found = await page.evaluate(async (sqlText) => {
    const hass = document.querySelector("home-assistant").hass;
    const editor = document.createElement("scribe-card-editor");
    editor.hass = hass;
    editor.setConfig({ type: "custom:scribe-card", sql: sqlText, ranges: ["24h", "7d"] });
    document.body.append(editor);
    await editor.updateComplete;
    // The editor waits for the typing to settle before it asks.
    await new Promise((done) => setTimeout(done, 2500));
    await editor.updateComplete;
    const text = editor.shadowRoot.textContent.replace(/\s+/g, " ");
    const form = Boolean(editor.shadowRoot.querySelector("ha-form"));
    editor.remove();
    return { text, form };
  }, RANGED_SQL);

  assert.equal(found.form, true, "the editor rendered no ha-form at all");
  assert.match(found.text, /Columns found: time, moyenne/, found.text.slice(0, 300));
  assert.doesNotMatch(found.text, /does not run yet/);
});

await check("two units in one chart get an axis each", async () => {
  const drawn = await (
    await card(page, "Two axes")
  ).evaluate((element) => {
    const option = element._chart.getOption();
    return {
      axes: option.yAxis.length,
      right: option.yAxis[1]?.position,
      names: option.yAxis.map((axis) => axis.name),
      min: option.yAxis[0]?.min,
      onRight: option.series.filter((one) => one.yAxisIndex === 1).map((one) => one.name),
      lines: option.yAxis.map((axis) => axis.splitLine?.show),
    };
  });

  assert.equal(drawn.axes, 2, "a second unit did not get a second axis");
  assert.equal(drawn.right, "right");
  assert.deepEqual(drawn.names, ["Degrés", "n"], "each axis is named for what it holds");
  assert.deepEqual(drawn.onRight, ["releves"], "the wrong series went to the right");
  assert.equal(drawn.min, 0, "an axis told to start at zero did not");
  assert.deepEqual(drawn.lines, [true, false], "both axes drew their own lines across");
});

await check("shares are shares of the axis they are drawn against", async () => {
  const drawn = await (
    await card(page, "Shares")
  ).evaluate((element) => {
    const option = element._chart.getOption();
    const series = Object.fromEntries(option.series.map((one) => [one.name, one]));
    const at = (one) => one.data.at(-1)[1] ?? one.data.at(-1);
    return {
      left: option.yAxis[0],
      rightName: option.yAxis[1]?.name,
      shares: at(series.chaud) + at(series.froid),
      counted: at(series.releves),
      onRight: series.releves.yAxisIndex,
      colour: series.chaud.itemStyle.color,
    };
  });

  assert.equal(drawn.left.name, "%", "the axis of shares still claimed degrees");
  assert.deepEqual([drawn.left.min, drawn.left.max], [0, 100]);
  // The two columns on the left are the whole of it. The count on the right is
  // not part of any share — and had it been normalised with them, all three
  // would come to a hundred instead of the two.
  assert.ok(Math.abs(drawn.shares - 100) < 0.001, `the shares came to ${drawn.shares}`);
  assert.ok(
    drawn.shares + drawn.counted > 100.5,
    `all three came to ${drawn.shares + drawn.counted}: the count was normalised too`,
  );
  assert.equal(drawn.onRight, 1);
  assert.equal(drawn.rightName, "n");
  // A colour Home Assistant has a name for, resolved against the live theme.
  assert.match(drawn.colour, /^#[0-9a-f]{6}$/i, `colour came through as ${drawn.colour}`);
});

await check("colours are picked from the theme, one per drawn series", async () => {
  const seen = await page.evaluate(async () => {
    const hass = document.querySelector("home-assistant").hass;
    const editor = document.createElement("scribe-card-editor");
    editor.hass = hass;
    editor.setConfig({
      type: "custom:scribe-card",
      colors: ["red"],
      sql: `SELECT time_bucket('1 hour', time) AS time, avg(value) AS moyenne,
                   max(value) AS maximum
            FROM states WHERE entity_id = 'sensor.e2e_temperature'
              AND time > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
    });
    document.body.append(editor);
    await editor.updateComplete;
    await new Promise((done) => setTimeout(done, 2600));
    await editor.updateComplete;

    // Onto the Chart tab, and open every section on it.
    editor.shadowRoot.querySelectorAll(".tab")[1].click();
    await editor.updateComplete;
    await new Promise((done) => setTimeout(done, 400));

    const deep = (root, selector) => {
      const found = [];
      const walk = (node) => {
        found.push(...node.querySelectorAll(selector));
        for (const element of node.querySelectorAll("*"))
          if (element.shadowRoot) walk(element.shadowRoot);
      };
      walk(root);
      return found;
    };
    for (const panel of deep(editor.shadowRoot, "ha-expansion-panel")) panel.expanded = true;
    await editor.updateComplete;
    await new Promise((done) => setTimeout(done, 400));

    // The per-column pickers, not every colour the form offers — a warning
    // colour is picked the same way and is not one of these.
    const pickers = deep(editor.shadowRoot, "ha-color-picker").filter((one) =>
      (one.label ?? "").startsWith("Colour of"),
    );
    const seen = {
      pickers: pickers.length,
      labels: pickers.map((one) => one.label),
      values: pickers.map((one) => one.value ?? ""),
      text: editor.shadowRoot.textContent,
    };
    editor.remove();
    return seen;
  });

  assert.equal(seen.pickers, 2, "one colour picker per drawn series");
  assert.deepEqual(seen.labels, ["Colour of moyenne", "Colour of maximum"]);
  assert.equal(seen.values[0], "red", "what the configuration says is what is shown");
  // The x column is not drawn, so it gets no colour of its own.
  assert.equal(
    seen.labels.some((one) => one.includes("time")),
    false,
  );
  assert.doesNotMatch(seen.text, /#[0-9a-f]{6}/i, "hexadecimal is still being shown");
});

await check("the editor is in tabs, and each one shows its own fields", async () => {
  const seen = await page.evaluate(async () => {
    const hass = document.querySelector("home-assistant").hass;
    const editor = document.createElement("scribe-card-editor");
    editor.hass = hass;
    editor.setConfig({ type: "custom:scribe-card", sql: "SELECT 1 AS a, 2 AS b" });
    document.body.append(editor);
    await editor.updateComplete;

    // `ha-form` renders into its own shadow root, and the selectors into
    // theirs, so counting what is on screen means walking through them.
    const deep = (root, selector) => {
      const found = [];
      const walk = (node) => {
        found.push(...node.querySelectorAll(selector));
        for (const element of node.querySelectorAll("*")) {
          if (element.shadowRoot) walk(element.shadowRoot);
        }
      };
      walk(root);
      return found;
    };
    const labels = () => deep(editor.shadowRoot, "ha-selector, ha-expansion-panel").length;

    const tabs = [...editor.shadowRoot.querySelectorAll(".tab")].map((tab) =>
      tab.textContent.trim(),
    );
    const first = labels();
    editor.shadowRoot.querySelectorAll(".tab")[1].click();
    await editor.updateComplete;
    // The nested forms of a grid render on their own schedule.
    await new Promise((done) => setTimeout(done, 400));
    const second = labels();
    const current = editor.shadowRoot.querySelector(".tab.current")?.textContent.trim();

    editor.remove();
    return { tabs, first, second, current };
  });

  assert.deepEqual(seen.tabs, ["Query", "Chart", "Axes", "Time & data"]);
  assert.ok(seen.first > 0, "the first tab rendered no fields");
  assert.ok(seen.second > 0, "the second tab rendered no fields");
  assert.equal(seen.current, "Chart", "clicking a tab did not select it");
});

await check("a value set on one tab is not lost by visiting another", async () => {
  // `ha-form` is only ever given the fields of the tab on screen, so the
  // configuration it hands back has to carry the rest of them too.
  const config = await page.evaluate(async () => {
    const hass = document.querySelector("home-assistant").hass;
    const editor = document.createElement("scribe-card-editor");
    editor.hass = hass;
    editor.setConfig({ type: "custom:scribe-card", sql: "SELECT 1", title: "Before" });
    document.body.append(editor);
    await editor.updateComplete;

    let last;
    editor.addEventListener("config-changed", (event) => {
      last = event.detail.config;
    });

    // Type into the title, on the first tab.
    const form = editor.shadowRoot.querySelector("ha-form");
    form.dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: { ...editor._config, title: "After", unit: "°C" } },
        bubbles: true,
        composed: true,
      }),
    );
    await editor.updateComplete;

    // Then go to another tab and change something there.
    editor.shadowRoot.querySelectorAll(".tab")[2].click();
    await editor.updateComplete;
    editor.shadowRoot.querySelector("ha-form").dispatchEvent(
      new CustomEvent("value-changed", {
        detail: { value: { ...editor._config, zoom: true } },
        bubbles: true,
        composed: true,
      }),
    );
    await editor.updateComplete;

    editor.remove();
    return last;
  });

  assert.equal(config.title, "After", "the title was lost on the way to another tab");
  assert.equal(config.unit, "°C", "the unit was lost");
  assert.equal(config.zoom, true, "the second tab's own change did not stick");
  assert.equal(config.sql, "SELECT 1", "the query was lost");
});

await check("a card in a sections view asks for a height that fits it", async () => {
  await page.goto(`${DASHBOARD_URL}/1`, { waitUntil: "domcontentloaded" });
  await page.locator("scribe-card").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  const box = await page.locator("scribe-card").first().boundingBox();
  const chart = await page
    .locator("scribe-card")
    .first()
    .evaluate(
      (element) => element.shadowRoot.querySelector(".chart")?.getBoundingClientRect().height,
    );
  assert.ok(chart >= 240, `the chart is ${chart}px tall, not the 250 it asked for`);
  assert.ok(box.height >= chart, "the card is shorter than the chart inside it");
});

if (problems.length) {
  checks.push([false, "the browser complained", new Error(problems.join("\n    "))]);
}

for (const [ok, name, error] of checks) {
  console.log(`${ok ? "ok" : "not ok"} — ${name}`);
  if (!ok) console.error(`    ${error.message.split("\n").slice(0, 4).join("\n    ")}`);
}

if (notOurs.length) {
  console.log(`\n(${notOurs.length} complaint(s) from before the card existed, not its doing)`);
  for (const line of notOurs) console.log(`    ${line}`);
}

const failed = checks.filter(([ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

if (failed) console.error(`\n--- home assistant log ---\n${await haLog(20)}`);

await browser.close();
if (process.env.E2E_KEEP) {
  console.log(`\nleft standing at ${BASE_URL} (e2e / e2e-password-1234)`);
} else {
  await cleanup(rig.configDir);
}
process.exit(failed ? 1 : 0);
