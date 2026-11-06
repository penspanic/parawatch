// Builds the app into dist/: main and preload as CommonJS for Electron, the page as one script.
import fs from "node:fs";
import esbuild from "esbuild";

process.chdir(new URL(".", import.meta.url).pathname);
const watch = process.argv.includes("--watch");
const common = { bundle: true, target: "es2022", logLevel: "info", sourcemap: watch ? "inline" : false };

const builds = [
  { ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs", platform: "node", format: "cjs", external: ["electron"] },
  { ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", external: ["electron"] },
  { ...common, entryPoints: ["src/renderer.ts"], outfile: "dist/renderer.js", platform: "browser", format: "iife" },
];

const copy = () => {
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync("src/index.html", "dist/index.html");
  fs.copyFileSync("src/app.css", "dist/app.css");
  fs.copyFileSync("../../packages/panel/panel.css", "dist/panel.css");
  fs.copyFileSync("../../packages/panel/theme.css", "dist/theme.css");
};

if (watch) {
  copy();
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copy();
}
