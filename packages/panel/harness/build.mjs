// Builds harness/out/: a plain page that renders the panel with sample cards, for working on it
// outside the desktop app.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
await esbuild.build({
  entryPoints: ["harness/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: "harness/out/harness.js",
  logLevel: "info",
});
fs.copyFileSync("panel.css", "harness/out/styles.css");
fs.copyFileSync("theme.css", "harness/out/theme.css");
fs.copyFileSync("harness/index.html", "harness/out/index.html");
if (fs.existsSync("harness/snapshot.json")) fs.copyFileSync("harness/snapshot.json", "harness/out/snapshot.json");
if (fs.existsSync("harness/icons.json")) fs.copyFileSync("harness/icons.json", "harness/out/icons.json");
