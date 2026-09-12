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

  window.__hass = (theme = "default", darkMode = false) => ({
    themes: { theme, darkMode },
    language: "en",
    callService: async () => {
      window.__calls++;
      if (window.__fail) throw new Error('relation "states" does not exist');
      return { response: { result: window.__rows } };
    },
  });

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

await browser.close();

for (const [ok, name, error] of checks) {
  console.log(`${ok ? "ok" : "not ok"} — ${name}`);
  if (!ok) console.error(`    ${error.message}`);
}
if (problems.length) console.error(`The browser complained:\n  ${problems.join("\n  ")}`);

const failed = checks.filter(([ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed || problems.length ? 1 : 0);
