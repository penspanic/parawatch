import { builtinModules } from "node:module";
import fs from "node:fs";
import esbuild from "esbuild";

const mode = process.argv[2] ?? "dev";

if (mode === "harness") {
  // A browser page that renders the panel against fixture data, for looking at it outside Obsidian.
  await esbuild.build({
    entryPoints: ["harness/main.ts"],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: "harness/out/harness.js",
    logLevel: "info",
  });
  fs.copyFileSync("styles.css", "harness/out/styles.css");
  fs.copyFileSync("harness/index.html", "harness/out/index.html");
  if (fs.existsSync("harness/snapshot.json")) fs.copyFileSync("harness/snapshot.json", "harness/out/snapshot.json");
} else {
  const prod = mode === "production";
  const ctx = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    target: "es2022",
    platform: "node",
    outfile: "dist/main.js",
    external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    sourcemap: prod ? false : "inline",
    minify: prod,
    logLevel: "info",
  });
  // Obsidian does not load a plugin whose folder is a symlink, so a vault gets real copies.
  const vaultDir = process.env.PARAWATCH_OBSIDIAN_PLUGIN_DIR;
  const copy = () => {
    fs.mkdirSync("dist", { recursive: true });
    fs.copyFileSync("manifest.json", "dist/manifest.json");
    fs.copyFileSync("styles.css", "dist/styles.css");
    if (vaultDir && fs.existsSync("dist/main.js")) {
      fs.mkdirSync(vaultDir, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(`dist/${f}`, `${vaultDir}/${f}`);
    }
  };
  if (prod) {
    await ctx.rebuild();
    copy();
    await ctx.dispose();
  } else {
    copy();
    await ctx.watch();
  }
}
