// Builds harness/out/: a plain page that renders the panel with sample cards, for working on it
// outside the desktop app.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
await esbuild.build({
  // esbuild resolves from the folder node started in, not the one chdir moved to
  absWorkingDir: process.cwd(),
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

// sample videos for the video comparison card, when ffmpeg is there: two of one size and length,
// and a longer, smaller one
const videos = [
  ["trail-off.mp4", "testsrc=size=1280x720:rate=30:duration=6", []],
  ["trail-on.mp4", "testsrc=size=1280x720:rate=30:duration=6", ["-vf", "hue=h=120"]],
  ["trail-long.mp4", "testsrc=size=960x540:rate=30:duration=8", ["-vf", "negate"]],
];
fs.mkdirSync("harness/out/media", { recursive: true });
for (const [name, src, extra] of videos) {
  const out = `harness/out/media/${name}`;
  if (fs.existsSync(out)) continue;
  const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", src, ...extra, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-g", "30", "-y", out], { stdio: "inherit" });
  if (r.error || r.status) {
    console.log("ffmpeg is not there or failed: the video comparison card shows no videos");
    break;
  }
}
