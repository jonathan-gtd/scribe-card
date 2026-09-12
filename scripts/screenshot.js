/** Render the built card in a headless browser and photograph it.
 *
 * The card in the README is the real one: this loads `dist/scribe-card.js`,
 * hands it the rows a query would return, and screenshots what it draws. The
 * only things faked are the two Home Assistant elements the card sits in
 * (`ha-card`, `ha-icon`) and the service call, which returns sample rows.
 *
 *     npm run screenshot
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

/** The Chromium Playwright downloaded, whichever build is around. */
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(resolve(root, "dist/scribe-card.js"), "utf8");

/** A month of daily temperatures, and a day of Scribe's own throughput. */
function sampleRows() {
  const temperature = [];
  const throughput = [];

  const firstDay = Date.UTC(2026, 7, 14);
  for (let day = 0; day < 30; day++) {
    const at = new Date(firstDay + day * 86_400_000).toISOString();
    // Late summer cooling off, with the wobble any month has.
    const average = 22 - day * 0.22 + 2.2 * Math.sin(day / 2.4) + (day % 4) * 0.3;
    temperature.push({
      day: at,
      minimum: average - 4.4 - (day % 3) * 0.4,
      average,
      maximum: average + 5.1 + (day % 5) * 0.3,
    });
  }

  const firstHour = Date.UTC(2026, 8, 11, 8, 0, 0);
  for (let hour = 0; hour < 24; hour++) {
    throughput.push({
      time: new Date(firstHour + hour * 3_600_000).toISOString(),
      states: Math.round(1400 + 900 * Math.sin(hour / 3) + (hour % 5) * 120),
    });
  }

  return { temperature, throughput };
}

const page = await (
  await chromium.launch({ executablePath: chromiumPath() })
).newPage({ viewport: { width: 900, height: 760 } });
page.on("console", (message) => {
  if (message.type() === "error") console.error("browser:", message.text());
});

await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #f4f5f7; font-family: Roboto, system-ui, sans-serif;
         --primary-text-color:#212121; --secondary-text-color:#727272; --divider-color:#e0e0e0;
         --primary-color:#03a9f4; --card-background-color:#fff; --ha-card-border-radius:12px; }
  .cards { display: grid; gap: 20px; }
</style></head>
<body><div class="cards"></div></body></html>`);

// The page is about:blank, which cannot import from file://; the bundle goes
// in as a module script instead, exactly as built.
await page.addScriptTag({ content: bundle, type: "module" });
await page.waitForFunction(() => customElements.get("scribe-card") !== undefined);

await page.evaluate(() => {
  // The two Home Assistant elements the card renders into, reduced to what
  // they look like: a card surface and an icon slot.
  customElements.define(
    "ha-card",
    class extends HTMLElement {
      connectedCallback() {
        const header = this.getAttribute("header") ?? this.header;
        this.attachShadow({ mode: "open" }).innerHTML = `<style>
          :host { display:block; background:var(--card-background-color,#fff);
                  border-radius:var(--ha-card-border-radius,12px);
                  box-shadow:0 2px 2px rgba(0,0,0,.14),0 1px 5px rgba(0,0,0,.12); }
          .header { font-size:20px; padding:14px 16px 4px; color:var(--primary-text-color); }
        </style>${header ? `<div class="header">${header}</div>` : ""}<slot></slot>`;
      }
    },
  );
  customElements.define("ha-icon", class extends HTMLElement {});
});

const { temperature, throughput } = sampleRows();

for (const [rows, config] of [
  [
    temperature,
    {
      type: "custom:scribe-card",
      title: "Outside temperature, daily minimum, average and maximum",
      unit: "°C",
      height: 240,
    },
  ],
  [
    throughput,
    {
      type: "custom:scribe-card",
      title: "States recorded per hour",
      chart: "area",
      height: 200,
      colors: ["#009e73"],
    },
  ],
]) {
  await page.evaluate(
    async ({ rows, config }) => {
      const card = document.createElement("scribe-card");
      card.setConfig({ ...config, sql: "…" });
      card.hass = {
        themes: { darkMode: false },
        language: "en",
        callService: async () => ({ response: { result: rows } }),
      };
      document.querySelector(".cards").append(card);
      await card.updateComplete;
      // The chart draws on the update after the rows land.
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
    { rows, config },
  );
}

await page.waitForTimeout(400);
await mkdir(resolve(root, "docs"), { recursive: true });
await page.locator(".cards").screenshot({ path: resolve(root, "docs/screenshot.png") });
console.log("docs/screenshot.png");
process.exit(0);
