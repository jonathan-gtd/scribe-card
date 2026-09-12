/** Render the built card in a headless browser and photograph it.
 *
 * The card in the README is the real one: this loads `dist/scribe-card.js`,
 * hands it the rows a query would return, and screenshots what it draws. The
 * only things faked are the two Home Assistant elements the card sits in
 * (`ha-card`, `ha-icon`) and the service call, which returns sample rows.
 *
 *     npm run screenshot
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { openCard, root } from "./harness.js";

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

const { browser, page, problems } = await openCard();
const { temperature, throughput } = sampleRows();

for (const [rows, config] of [
  [
    temperature,
    {
      type: "custom:scribe-card",
      sql: "SELECT day, minimum, average, maximum FROM …",
      title: "Outside temperature, daily minimum, average and maximum",
      unit: "°C",
      height: 240,
    },
  ],
  [
    throughput,
    {
      type: "custom:scribe-card",
      sql: "SELECT time, states FROM …",
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
      card.setConfig({ sql: "…", ...config });
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
await browser.close();

if (problems.length) {
  console.error(`The card did not render cleanly:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

console.log("docs/screenshot.png");
process.exit(0);
