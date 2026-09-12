/** A browser with the built card in it.
 *
 * Shared by `screenshot.js`, which photographs the card, and `smoke.js`, which
 * checks the behaviour a photograph cannot show. Both load `dist/scribe-card.js`
 * — the file HACS installs — into a real Chromium, and both fail on anything
 * the browser complained about.
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Somewhere with an origin. Nothing is fetched from it but the page itself. */
const ORIGIN = "https://scribe-card.test";

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

/**
 * A page with the card defined, the two Home Assistant elements it renders
 * into, and a list of everything the browser complained about.
 */
export async function openCard({ viewport = { width: 900, height: 760 } } = {}) {
  const bundle = await readFile(resolve(root, "dist/scribe-card.js"), "utf8");
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const page = await browser.newPage({ viewport });

  /** Anything the browser complained about: the card must render silently. */
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));

  // A real origin, not `about:blank`: the card remembers a chosen range in
  // `localStorage`, and an opaque origin has none to remember it in — which is
  // also why the card treats storage as something that can refuse.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #f4f5f7; font-family: Roboto, system-ui, sans-serif;
         --primary-text-color:#212121; --secondary-text-color:#727272; --divider-color:#e0e0e0;
         --primary-color:#03a9f4; --card-background-color:#fff; --ha-card-border-radius:12px; }
  .cards { display: grid; gap: 20px; }
</style></head>
<body><div class="cards"></div></body></html>`;

  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(ORIGIN);

  // Nothing here is served from disk, so the bundle goes in as a module script
  // instead, exactly as built.
  await page.addScriptTag({ content: bundle, type: "module" });
  await page.waitForFunction(() => customElements.get("scribe-card") !== undefined);

  await page.evaluate(() => {
    // The two Home Assistant elements the card renders into, reduced to what
    // they look like: a card surface and an icon slot.
    customElements.define(
      "ha-card",
      class extends HTMLElement {
        connectedCallback() {
          // A card moved across a dashboard connects a second time, and a
          // shadow root can only be attached once.
          if (this.shadowRoot) return;
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

  return { browser, page, problems };
}
