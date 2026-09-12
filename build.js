// One bundled file, which is what HACS installs and Home Assistant loads.
import { readFile } from "node:fs/promises";

import { build } from "esbuild";

// The version the card announces comes from here, so it cannot disagree with
// the tag: the release workflow already checks the tag against package.json.
const { version } = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));

await build({
  define: { __VERSION__: JSON.stringify(version) },
  entryPoints: ["src/scribe-card.ts"],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: "esm",
  target: "es2021",
  outfile: "dist/scribe-card.js",
  legalComments: "none",
  loader: { ".css": "text" },
});
console.log("dist/scribe-card.js");
