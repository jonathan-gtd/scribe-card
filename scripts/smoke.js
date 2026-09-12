/** What a screenshot cannot show.
 *
 * The card's own behaviour — a query that fails, a refresh that fails after one
 * that worked, a card moved across a dashboard, a theme switched, a tab left in
 * the background — only happens in a browser, against the built bundle. These
 * are the checks for it.
 *
 *     npm run smoke
 */

import assert from "node:assert/strict";

import { openCard } from "./harness.js";

const { browser, page, problems } = await openCard({ viewport: { width: 700, height: 900 } });

/** Counters the checks read, and the two globals the card uses, spied on. */
await page.evaluate(() => {
  window.__draws = 0;
  window.__calls = 0;
  window.__fail = false;
  window.__hidden = false;
  window.__intervals = new Set();
  window.__lastDelay = undefined;

  // `_draw()` reads the dashboard's colours off the card element, exactly once
  // per draw: counting that is counting repaints, without touching the card.
  const style = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element, ...rest) => {
    if (element && element.tagName === "SCRIBE-CARD") window.__draws++;
    return style(element, ...rest);
  };

  const setInterval_ = window.setInterval.bind(window);
  const clearInterval_ = window.clearInterval.bind(window);
  window.setInterval = (handler, delay, ...rest) => {
    window.__lastDelay = delay;
    const handle = setInterval_(handler, delay, ...rest);
    window.__intervals.add(handle);
    return handle;
  };
  window.clearInterval = (handle) => {
    window.__intervals.delete(handle);
    return clearInterval_(handle);
  };

  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => window.__hidden === true,
  });

  // Rows that count being read: the row-to-series transform is the expensive
  // thing, and reading a row is the only trace of it from outside the card.
  window.__reads = 0;
  const row = (values) => {
    const counted = {};
    for (const [column, value] of Object.entries(values)) {
      Object.defineProperty(counted, column, {
        enumerable: true,
        get: () => {
          window.__reads++;
          return value;
        },
      });
    }
    return counted;
  };
  window.__rows = Array.from({ length: 24 }, (_, hour) =>
    row({ time: new Date(Date.UTC(2026, 8, 11, hour)).toISOString(), states: 1200 + hour * 30 }),
  );

  window.__sql = [];
  window.__sent = [];
  window.__userData = {};

  window.__hass = (theme = "default", darkMode = false) => ({
    themes: { theme, darkMode },
    language: "en",
    callService: async (domain, service, data) => {
      window.__calls++;
      window.__sql.push(data?.sql);
      if (window.__fail) throw new Error('relation "states" does not exist');
      return { response: { result: window.__rows } };
    },
    connection: {
      sendMessagePromise: async (message) => {
        window.__sent.push(message);
        if (message.type === "frontend/get_user_data") {
          return { value: window.__userData[message.key] };
        }
        window.__userData[message.key] = message.value;
        return undefined;
      },
    },
  });

  /** The picker, driven the way a person drives it. */
  window.__open = async (card) => {
    card.shadowRoot.querySelector(".trigger").click();
    await card.updateComplete;
  };
  window.__choose = async (card, label) => {
    const choice = [...card.shadowRoot.querySelectorAll(".choice")].find(
      (button) => button.textContent.trim() === label,
    );
    choice.click();
    await card.updateComplete;
    await window.__settle();
  };
  window.__label = (card) => card.shadowRoot.querySelector(".trigger span")?.textContent.trim();

  window.__settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));

  // A query of its own per card, so the shared cache cannot leak one check's
  // answer into the next.
  window.__n = 0;
  window.__card = async (config = {}, hass) => {
    const card = document.createElement("scribe-card");
    card.setConfig({
      type: "custom:scribe-card",
      sql: `SELECT time, states FROM … /* ${++window.__n} */`,
      ...config,
    });
    document.querySelector(".cards").append(card);
    card.hass = hass ?? window.__hass();
    await card.updateComplete;
    await window.__settle();
    return card;
  };

  window.__shows = (card) => ({
    error: Boolean(card.shadowRoot.querySelector(".error")),
    stale: Boolean(card.shadowRoot.querySelector(".stale")),
    chart: Boolean(card.shadowRoot.querySelector(".chart canvas")),
    text: card.shadowRoot.textContent.replace(/\s+/g, " ").trim(),
  });

  window.__visibility = async (hidden) => {
    window.__hidden = hidden;
    document.dispatchEvent(new Event("visibilitychange"));
    await window.__settle(150);
  };
});

const checks = [];
async function check(name, body) {
  try {
    await body();
    checks.push([true, name]);
  } catch (error) {
    checks.push([false, name, error]);
  }
}

await check("a query that fails shows what the database said", async () => {
  const shown = await page.evaluate(async () => {
    window.__fail = true;
    const card = await window.__card();
    const shown = window.__shows(card);
    card.remove();
    window.__fail = false;
    return shown;
  });
  assert.equal(shown.error, true, "the error block is missing");
  assert.equal(shown.chart, false, "a chart was drawn from a failed query");
  assert.match(shown.text, /relation "states" does not exist/);
});

await check("a refresh that fails keeps the chart that worked", async () => {
  const shown = await page.evaluate(async () => {
    const card = await window.__card({ refresh_interval: 30 });
    const drawn = window.__shows(card).chart;
    // Coming back to a visible tab queries at once, which is the refresh here.
    await window.__visibility(true);
    window.__fail = true;
    await window.__visibility(false);
    await window.__settle();
    const shown = { ...window.__shows(card), drawn };
    card.remove();
    window.__fail = false;
    return shown;
  });
  assert.equal(shown.drawn, true, "nothing was drawn to begin with");
  assert.equal(shown.chart, true, "a failed refresh erased a chart that worked");
  assert.equal(shown.stale, true, "nothing said the rows are older");
  assert.equal(shown.error, false, "a card with rows showed the full error block");
});

await check("a card moved across a dashboard draws itself again", async () => {
  const shown = await page.evaluate(async () => {
    const card = await window.__card();
    const before = window.__shows(card).chart;
    // What Lovelace does when a card changes column: the same element, moved.
    const parent = card.parentElement;
    card.remove();
    parent.append(card);
    await card.updateComplete;
    await window.__settle();
    const after = window.__shows(card).chart;
    card.remove();
    return { before, after };
  });
  assert.equal(shown.before, true, "nothing was drawn to begin with");
  assert.equal(shown.after, true, "the moved card came back as an empty frame");
});

await check("a theme change repaints the chart", async () => {
  const draws = await page.evaluate(async () => {
    const card = await window.__card();
    const before = window.__draws;
    card.hass = window.__hass("midnight", true);
    await card.updateComplete;
    await window.__settle();
    const after = window.__draws;
    card.remove();
    return { before, after };
  });
  assert.equal(draws.after, draws.before + 1, "the chart kept the colours of the old theme");
});

await check("state changes in the house do not rebuild the chart", async () => {
  const seen = await page.evaluate(async () => {
    const card = await window.__card();
    const reads = window.__reads;
    const draws = window.__draws;
    // Home Assistant hands every card a new `hass` on every state change, and
    // a busy house does that many times a second, to every card on the page.
    for (let i = 0; i < 40; i++) {
      card.hass = window.__hass();
      await card.updateComplete;
    }
    const after = { reads: window.__reads - reads, draws: window.__draws - draws };
    card.remove();
    return after;
  });
  assert.equal(seen.reads, 0, `forty state changes read the rows ${seen.reads} times over`);
  assert.equal(seen.draws, 0, "forty state changes repainted the chart");
});

await check("a hidden tab stops querying, and shows again on the way back", async () => {
  const seen = await page.evaluate(async () => {
    const card = await window.__card({ refresh_interval: 30 });
    const polling = window.__intervals.size;
    await window.__visibility(true);
    const hidden = window.__intervals.size;
    const callsWhileHidden = window.__calls;
    await window.__visibility(false);
    const visible = window.__intervals.size;
    const callsAfter = window.__calls;
    card.remove();
    return { polling, hidden, visible, queriedOnReturn: callsAfter > callsWhileHidden };
  });
  assert.equal(seen.hidden, seen.polling - 1, "a hidden tab kept its refresh timer");
  assert.equal(seen.visible, seen.polling, "the refresh did not resume with the tab");
  assert.equal(seen.queriedOnReturn, true, "the card showed stale rows on the way back");
});

await check("a refresh faster than the floor is slowed to it", async () => {
  const delay = await page.evaluate(async () => {
    const card = await window.__card({ refresh_interval: 1 });
    const delay = window.__lastDelay;
    card.remove();
    return delay;
  });
  assert.equal(delay, 5000, "a one-second refresh was left to hammer the database");
});

await check("a configuration the card cannot draw is refused", async () => {
  const thrown = await page.evaluate(() => {
    const bad = [
      { sql: "SELECT 1", chart: "ligne" },
      { sql: "SELECT 1", height: "grand" },
      { sql: "SELECT 1", step: "middel" },
      { sql: "SELECT 1", colors: "#fff" },
      {},
    ];
    return bad.map((config) => {
      const card = document.createElement("scribe-card");
      try {
        card.setConfig({ type: "custom:scribe-card", ...config });
        return null;
      } catch (error) {
        return error.message;
      }
    });
  });
  for (const [index, message] of thrown.entries()) {
    assert.ok(message, `configuration ${index} was accepted`);
    assert.match(message, /^scribe-card: /);
  }
});

await check("a card without Scribe says so, rather than saying nothing", async () => {
  const shown = await page.evaluate(async () => {
    const hass = window.__hass();
    // A frontend that knows every service, and not this one.
    hass.services = { light: { turn_on: {} } };
    const card = await window.__card({}, hass);
    const shown = window.__shows(card);
    card.remove();
    return shown;
  });
  assert.equal(shown.error, true, "nothing was said at all");
  assert.match(shown.text, /Scribe is not installed, or is older than 4\.0/);
});

await check("a sections view is told how tall the card is", async () => {
  const grids = await page.evaluate(async () => {
    const read = async (config) => {
      const card = await window.__card(config);
      const grid = card.getGridOptions();
      card.remove();
      return grid;
    };
    return {
      titled: await read({ title: "States per hour", height: 250 }),
      bare: await read({ height: 100 }),
      tall: await read({ title: "Tall", height: 600 }),
    };
  });
  assert.equal(grids.titled.columns, "full", "a chart is not read in half a section");
  assert.equal(grids.titled.rows, 6, "250px under a header is six 56px rows");
  assert.equal(grids.bare.rows, 2, "a short chart with no header is two");
  assert.ok(grids.tall.rows > grids.titled.rows, "a taller card asks for more rows");
  assert.ok(grids.titled.min_rows >= 1 && grids.titled.min_columns >= 1);
});

await check("the chart says what it shows, and the rows are there to read", async () => {
  const seen = await page.evaluate(async () => {
    const card = await window.__card({ title: "States recorded per hour" });
    const chart = card.shadowRoot.querySelector(".chart");
    const hidden = card.shadowRoot.querySelector(".sr-only");
    const table = hidden?.querySelector("table");
    const seen = {
      role: chart.getAttribute("role"),
      label: chart.getAttribute("aria-label"),
      headers: table ? [...table.querySelectorAll("th")].map((th) => th.textContent.trim()) : null,
      bodyRows: table ? table.querySelectorAll("tbody tr").length : 0,
      caption: table?.querySelector("caption")?.textContent.trim(),
      // Hidden from sight, not from a screen reader.
      width: hidden ? hidden.getBoundingClientRect().width : 0,
    };
    card.remove();
    return seen;
  });
  assert.equal(seen.role, "img");
  assert.match(seen.label, /^States recorded per hour\. A line chart of states, over 24 points\.$/);
  assert.deepEqual(seen.headers, ["time", "states"]);
  assert.equal(seen.bodyRows, 24, "the rows behind the chart are not there to read");
  assert.equal(seen.caption, "States recorded per hour");
  assert.ok(seen.width <= 1, "the table is visible, which is not the idea");
});

await check("two cards asking the same question ask the database once", async () => {
  const calls = await page.evaluate(async () => {
    const sql = "SELECT time, states FROM … /* shared */";
    const before = window.__calls;
    const cards = await Promise.all([window.__card({ sql }), window.__card({ sql })]);
    const after = window.__calls;
    for (const card of cards) card.remove();
    return { before, after };
  });
  assert.equal(calls.after - calls.before, 1, "the same question went to the database twice");
});

const RANGED =
  "SELECT time_bucket($__interval, time) AS time, count(*) AS states FROM s WHERE time > $__from";

await check("a query with holes in it gets a picker, and one without does not", async () => {
  const seen = await page.evaluate(async (sql) => {
    const ranged = await window.__card({ sql, ranges: ["24h", "7d"] });
    const plain = await window.__card({});
    const seen = {
      ranged: Boolean(ranged.shadowRoot.querySelector(".picker")),
      label: window.__label(ranged),
      plain: Boolean(plain.shadowRoot.querySelector(".toolbar")),
      // Nothing to fill means nothing to pick, whatever `ranges` says.
      ignored: Boolean(
        (await window.__card({ ranges: ["24h"] })).shadowRoot.querySelector(".picker"),
      ),
    };
    ranged.remove();
    plain.remove();
    return seen;
  }, RANGED);

  assert.equal(seen.ranged, true, "a query with markers got no picker");
  assert.equal(seen.label, "Last 24 hours", "the first range is the one it opens on");
  assert.equal(seen.plain, false, "a plain card grew a toolbar it has no use for");
  assert.equal(seen.ignored, false, "ranges were offered for a query that cannot use them");
});

await check("choosing a range rewrites the query, and remembers the choice", async () => {
  const seen = await page.evaluate(async (sql) => {
    const card = await window.__card({ sql, ranges: ["24h", "7d"] });
    const before = window.__sql.length;
    await window.__open(card);
    await window.__choose(card, "Last 7 days");
    const asked = window.__sql.slice(before).at(-1);
    const key = Object.keys(window.__userData)[0];
    const seen = {
      asked,
      label: window.__label(card),
      closed: !card.shadowRoot.querySelector(".menu"),
      remembered: window.__userData[key],
      local: JSON.parse(window.localStorage.getItem(key)),
      key,
    };
    card.remove();
    return seen;
  }, RANGED);

  assert.equal(seen.label, "Last 7 days");
  assert.equal(seen.closed, true, "the menu stayed open over the chart");
  assert.match(seen.asked, /time_bucket\('30 minutes', time\)/, "the bucket did not follow");
  assert.match(seen.asked, /> '\d{4}-\d\d-\d\dT[\d:.]+Z'::timestamptz/);
  assert.equal(seen.asked.includes("$__"), false, "a marker reached the database");
  assert.deepEqual(seen.remembered, { last: "7d" }, "Home Assistant was not told");
  assert.deepEqual(seen.local, { last: "7d" }, "the browser was not told");
  assert.match(seen.key, /^scribe-card\./);
});

await check("a card opens on the range it was left on", async () => {
  const label = await page.evaluate(async (sql) => {
    // What the browser remembers is there before anything is asked, so the
    // card must not flicker through its default first.
    const card = await window.__card({ sql, ranges: ["24h", "7d"], storage_key: "kitchen" });
    const first = window.__label(card);
    card.remove();

    window.localStorage.setItem("scribe-card.kitchen", JSON.stringify({ last: "7d" }));
    const again = await window.__card({ sql, ranges: ["24h", "7d"], storage_key: "kitchen" });
    const restored = window.__label(again);
    again.remove();
    window.localStorage.removeItem("scribe-card.kitchen");
    return { first, restored };
  }, RANGED);

  assert.equal(label.first, "Last 24 hours");
  assert.equal(label.restored, "Last 7 days", "the card forgot where it was left");
});

await check("what Home Assistant remembers reaches a browser that never knew", async () => {
  const seen = await page.evaluate(async (sql) => {
    // A second machine: the user store has a range, this browser has nothing.
    window.__userData["scribe-card.bedroom"] = { last: "30d" };
    window.localStorage.removeItem("scribe-card.bedroom");
    const card = await window.__card({ sql, ranges: ["24h", "7d", "30d"], storage_key: "bedroom" });
    await window.__settle(200);
    const seen = { label: window.__label(card), asked: window.__sql.at(-1) };
    card.remove();
    delete window.__userData["scribe-card.bedroom"];
    return seen;
  }, RANGED);

  assert.equal(seen.label, "Last 30 days", "the user store was not consulted");
  assert.match(seen.asked, /time_bucket\('3 hours', time\)/, "the restored range was not queried");
});

await check("a range nobody should trust is not believed", async () => {
  const label = await page.evaluate(async (sql) => {
    window.localStorage.setItem("scribe-card.junk", JSON.stringify({ last: "everything" }));
    const card = await window.__card({ sql, ranges: ["24h"], storage_key: "junk" });
    const label = window.__label(card);
    card.remove();
    window.localStorage.removeItem("scribe-card.junk");
    return label;
  }, RANGED);

  assert.equal(label, "Last 24 hours", "a stored range nobody validated was used");
});

await check("the menu is not clipped by the card it drops out of", async () => {
  const overflow = await page.evaluate(async (sql) => {
    const card = await window.__card({ sql, ranges: ["24h", "7d"], height: 120 });
    const of = () => getComputedStyle(card.shadowRoot.querySelector("ha-card")).overflow;
    const closed = of();
    await window.__open(card);
    const open = of();
    card.remove();
    return { closed, open };
  }, RANGED);

  // Hidden keeps the chart inside the card's rounded corners; a dropdown that
  // is clipped by the thing it drops out of is no dropdown.
  assert.equal(overflow.closed, "hidden");
  assert.equal(overflow.open, "visible");
});

await check("a custom range is the two instants it was given", async () => {
  const seen = await page.evaluate(async (sql) => {
    const card = await window.__card({ sql, ranges: ["24h"], storage_key: "custom" });
    await window.__open(card);
    await window.__choose(card, "Custom…");

    const at = (name) => card.shadowRoot.querySelector(`input[name="${name}"]`);
    at("from").value = "2026-01-01T00:00";
    at("to").value = "2026-01-08T00:00";
    card.shadowRoot.querySelector(".apply").click();
    await card.updateComplete;
    await window.__settle();

    const seen = {
      label: window.__label(card),
      asked: window.__sql.at(-1),
      remembered: window.__userData["scribe-card.custom"],
    };
    card.remove();
    window.localStorage.removeItem("scribe-card.custom");
    return seen;
  }, RANGED);

  assert.match(seen.label, /—/, "the trigger still says 'Last 24 hours'");
  // A week, whatever the machine's timezone: the bucket follows the span.
  assert.match(seen.asked, /time_bucket\('30 minutes', time\)/);
  assert.equal(seen.asked.includes("$__"), false);
  assert.equal(typeof seen.remembered.from, "number", "an absolute range is two instants");
  assert.equal(seen.remembered.to - seen.remembered.from, 7 * 86_400_000, "seven days");
});

await check("the rows come back as a CSV file", async () => {
  const file = await page.evaluate(async () => {
    const card = await window.__card({ title: "States per hour", export: true });
    const make = URL.createObjectURL.bind(URL);
    let blob;
    URL.createObjectURL = (given) => {
      blob = given;
      return make(given);
    };
    const button = card.shadowRoot.querySelector("button.icon");
    let name;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      name = this.download;
    };
    button.click();
    HTMLAnchorElement.prototype.click = click;
    URL.createObjectURL = make;
    const text = blob ? await blob.text() : "";
    card.remove();
    return { text, name, type: blob?.type };
  });

  const lines = file.text.split("\n");
  assert.equal(lines[0], "time,states", "the header is the columns the query returned");
  assert.equal(lines.length, 25, "24 rows and a header");
  assert.match(lines[1], /^2026-09-11T00:00:00\.000Z,1200$/);
  assert.equal(file.name, "states-per-hour.csv");
  assert.match(file.type, /^text\/csv/);
});

await browser.close();

for (const [ok, name, error] of checks) {
  console.log(`${ok ? "ok" : "not ok"} — ${name}`);
  if (!ok) console.error(`    ${error.message}`);
}
if (problems.length) console.error(`The browser complained:\n  ${problems.join("\n  ")}`);

const failed = checks.filter(([ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed || problems.length ? 1 : 0);
