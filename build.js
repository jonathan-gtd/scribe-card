// One bundled file, which is what HACS installs and Home Assistant loads.
import { build } from "esbuild";

await build({
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
