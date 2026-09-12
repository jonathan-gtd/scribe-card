/** Photograph a card and its editor, in a real Home Assistant.
 *
 * The editor is `ha-form`, which only exists inside Home Assistant's frontend;
 * there is no way to look at it without one. This puts a card and the form
 * that configures it side by side, so a change to either can be seen rather
 * than guessed at.
 *
 *     npm run e2e:shot                      the default card, into docs/
 *     npm run e2e:shot card.json out.png    a configuration of your own
 *
 * `E2E_KEEP=1 npm run e2e` first leaves an instance standing, and this reuses
 * it — a second or two instead of a minute.
 */

import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { BASE_URL, hassTokens, root, seed, up } from "./rig.js";

function chromiumPath() {
  const base = resolve(process.env.HOME ?? "", ".cache/ms-playwright");
  return readdirSync(base)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => resolve(base, name, "chrome-linux64/chrome"))
    .filter((path) => existsSync(path))
    .sort()
    .at(-1);
}

const CONFIG = {
  type: "custom:scribe-card",
  title: "Température",
  unit: "°C",
  height: 200,
  chart: "area",
  ranges: ["24h", "7d", "30d"],
  sql: `SELECT time_bucket($__interval, time) AS time, avg(value) AS moyenne
FROM states WHERE entity_id = 'sensor.e2e_temperature'
  AND time >= $__from AND time < $__to
GROUP BY 1 ORDER BY 1`,
};

const [configPath, outPath] = process.argv.slice(2);
const config = configPath ? JSON.parse(await readFile(configPath, "utf8")) : CONFIG;
const out = resolve(root, outPath ?? "docs/editor.png");

const rig = await up({ reuse: true });
await seed();

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage({
  viewport: { width: 1000, height: 1200 },
  locale: "fr-FR",
  timezoneId: "Europe/Paris",
});
await page.addInitScript(
  (tokens) => localStorage.setItem("hassTokens", JSON.stringify(tokens)),
  hassTokens(rig.tokens),
);

await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector("home-assistant")?.hass?.services, null, {
  timeout: 60_000,
});
// Resources are fetched for a Lovelace dashboard and not for the landing page,
// so there has to be one to go to.
await page.evaluate(async () => {
  const hass = document.querySelector("home-assistant").hass;
  const resources = await hass.callWS({ type: "lovelace/resources" });
  if (!resources?.some?.((one) => one.url.includes("scribe-card"))) {
    await hass.callWS({
      type: "lovelace/resources/create",
      res_type: "module",
      url: "/local/scribe-card.js?v=shot",
    });
  }
  const dashboards = await hass.callWS({ type: "lovelace/dashboards/list" });
  if (!dashboards?.some?.((one) => one.url_path === "e2e-cards")) {
    await hass.callWS({
      type: "lovelace/dashboards/create",
      url_path: "e2e-cards",
      title: "E2E",
      mode: "storage",
      show_in_sidebar: true,
      require_admin: false,
    });
    await hass.callWS({
      type: "lovelace/config/save",
      url_path: "e2e-cards",
      config: { views: [{ title: "t", cards: [] }] },
    });
  }
});
await page.goto(`${BASE_URL}/e2e-cards/0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => customElements.get("scribe-card") !== undefined, null, {
  timeout: 30_000,
});

/**
 * The card, and the form that configures it once per tab — every screen in one
 * look, with the collapsible sections opened so their contents can be judged.
 */
await page.evaluate(async (cardConfig) => {
  const hass = document.querySelector("home-assistant").hass;
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));

  document.body.innerHTML = `<div id="shot" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px;background:var(--primary-background-color,#f4f5f7);align-items:start"></div>`;
  const holder = document.getElementById("shot");

  const card = document.createElement("scribe-card");
  card.setConfig(cardConfig);
  card.hass = hass;
  holder.append(card);
  await card.updateComplete;

  const pane = () => {
    const box = document.createElement("div");
    box.style.cssText =
      "background:var(--card-background-color,#fff);border-radius:12px;padding:16px;box-shadow:0 2px 2px rgba(0,0,0,.14)";
    return box;
  };

  // One editor per tab, each clicked onto its own.
  const first = document.createElement("scribe-card-editor");
  first.hass = hass;
  first.setConfig(cardConfig);
  const box = pane();
  box.append(first);
  holder.append(box);
  await first.updateComplete;
  // Long enough for the query behind the column list to come back.
  await wait(2600);
  await first.updateComplete;

  const tabs = [...first.shadowRoot.querySelectorAll(".tab")].length;
  for (let index = 1; index < tabs; index++) {
    const editor = document.createElement("scribe-card-editor");
    editor.hass = hass;
    editor.setConfig(cardConfig);
    const holderBox = pane();
    holderBox.append(editor);
    holder.append(holderBox);
    await editor.updateComplete;
    editor.shadowRoot.querySelectorAll(".tab")[index].click();
    await editor.updateComplete;
  }

  await wait(600);
}, config);

// Open every section, so what is inside them can be judged. Clicked rather
// than set: `ha-expansion-panel` is the frontend's, and its own header is the
// only part of it this has any business touching.
for (const panel of await page.locator("ha-expansion-panel").all()) {
  await panel.click({ position: { x: 40, y: 20 } }).catch(() => undefined);
}
await page.waitForTimeout(600);

await page.waitForTimeout(600);
await page.locator("#shot").screenshot({ path: out });
await browser.close();

console.log(out);
if (!rig.reused) console.log("(brought an instance up; E2E_KEEP=1 npm run e2e keeps one standing)");
process.exit(0);
