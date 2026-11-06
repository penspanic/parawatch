// Writes build/icon.png (1024 px) for electron-builder, drawn by the same code as the running app.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artPng } from "../src/art.js";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, artPng("app", 1024));
process.stdout.write(`${out}\n`);
