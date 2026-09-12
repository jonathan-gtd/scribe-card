// Node cannot import TypeScript, so the modules under test are bundled first.
import { build } from "esbuild";

await build({
  entryPoints: ["src/series.ts"],
  bundle: true,
  format: "esm",
  target: "es2021",
  outfile: ".test/series.js",
});
