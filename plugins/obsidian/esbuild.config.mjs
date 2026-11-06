import { builtinModules } from "node:module";
import fs from "node:fs";
import esbuild from "esbuild";

const mode = process.argv[2] ?? "dev";

// The panel's stylesheet lives in the shared package; Obsidian wants it as styles.css.
const STYLES = new URL("../../packages/panel/panel.css", import.meta.url).pathname;

{
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
    fs.copyFileSync(STYLES, "dist/styles.css");
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
