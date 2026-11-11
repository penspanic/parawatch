// Fails when a built app carries more than the app: anything outside dist/ and package.json, or
// any text naming the home folder of the machine that built it. Run on each built app: a macOS
// Parawatch.app, or the Windows and Linux app folder (release/win-unpacked).
//
//   node scripts/check-package.cjs release/mac-arm64/Parawatch.app release/win-unpacked [...]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");

const home = os.homedir();
const user = path.basename(home);
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`check-package: ${msg}`);
};

for (const app of process.argv.slice(2)) {
  const resources = app.endsWith(".app") ? path.join(app, "Contents", "Resources") : path.join(app, "resources");
  const archive = path.join(resources, "app.asar");
  const files = asar.listPackage(archive, { isPack: false }).map((f) => f.replace(/\\/g, "/"));
  const extra = files.filter((f) => !(f === "/dist" || f.startsWith("/dist/") || f === "/package.json"));
  if (extra.length) fail(`${archive} holds files outside dist/: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ` and ${extra.length - 8} more` : ""}`);
  for (const f of files) {
    let text;
    try {
      text = asar.extractFile(archive, f.slice(1)).toString("utf8");
    } catch {
      continue; // a folder
    }
    if (text.includes(home) || text.includes(`/Users/${user}/`) || text.includes(`-Users-${user}-`) || text.includes(`\\Users\\${user}\\`) || text.includes(`/home/${user}/`)) fail(`${f} in ${archive} names this machine's home folder`);
  }
  if (!fs.existsSync(path.join(resources, "app-update.yml"))) fail(`${app} has no app-update.yml, so it cannot update itself`);
  if (!failed) console.log(`check-package: ${app} holds only the app (${files.length} entries)`);
}
process.exit(failed ? 1 : 0);
