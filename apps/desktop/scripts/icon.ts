// Writes build/icon.png (1024 px), the icon for Windows and Linux packages.
//
// On a Mac with Xcode, Icon Composer's ictool renders the Liquid Glass icon from icon/Parawatch.icon,
// so every platform gets the same picture. Elsewhere the flat version drawn in code stands in.
// A packaged macOS app does not use this file: electron-builder compiles Parawatch.icon itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artPng } from "../src/art.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "icon.png");
const source = path.join(root, "icon", "Parawatch.icon");
const ictool = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool";
fs.mkdirSync(path.dirname(out), { recursive: true });

let how = "drawn in code";
if (process.platform === "darwin" && fs.existsSync(ictool)) {
  try {
    execFileSync(ictool, [source, "--export-image", "--output-file", out, "--platform", "macOS", "--rendition", "Default", "--width", "1024", "--height", "1024", "--scale", "1"], { stdio: "ignore" });
    how = "rendered by Icon Composer";
  } catch {
    // fall back to the drawn icon below
  }
}
if (how === "drawn in code") fs.writeFileSync(out, artPng("app", 1024));
process.stdout.write(`${out} (${how})\n`);
