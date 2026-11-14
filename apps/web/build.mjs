// Builds the phone web app into dist/: one script, the panel's styles, the app icon, and a service
// worker named after the version so a new one replaces the old.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const stamp = `${version}-${Date.now().toString(36)}`;
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist");
await esbuild.build({
  absWorkingDir: process.cwd(),
  entryPoints: ["src/main.ts"],
  outfile: "dist/app.js",
  bundle: true,
  format: "iife",
  target: ["es2022", "safari16"],
  minify: true,
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
for (const f of ["index.html", "app.css", "manifest.webmanifest"]) fs.copyFileSync(`src/${f}`, `dist/${f}`);
fs.writeFileSync("dist/sw.js", fs.readFileSync("src/sw.js", "utf8").replace("__VERSION__", stamp));
fs.copyFileSync("../../packages/panel/panel.css", "dist/panel.css");
fs.copyFileSync("../../packages/panel/theme.css", "dist/theme.css");
// the app icon at a size a home screen uses; macOS has sips, elsewhere the big one is copied
try {
  execFileSync("sips", ["-Z", "512", "../desktop/build/icon.png", "--out", "dist/icon.png"], { stdio: "ignore" });
} catch {
  fs.copyFileSync("../desktop/build/icon.png", "dist/icon.png");
}
