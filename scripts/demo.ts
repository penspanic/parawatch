// Builds a made-up world for screenshots and for trying the panel: two projects, a few
// cards, and fake Claude Code and Codex logs with an hour of activity. Nothing here
// touches your real store or agent logs.
//
//   npx tsx scripts/demo.ts /tmp/pw-demo
//
// It prints the environment variables that point parawatch (the CLI and the desktop
// app) at the demo folder.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "/tmp/pw-demo");
fs.rmSync(root, { recursive: true, force: true });

const env = {
  PARAWATCH_HOME: path.join(root, "state"),
  PARAWATCH_CLAUDE_DIR: path.join(root, "claude", "projects"),
  PARAWATCH_CODEX_DIR: path.join(root, "codex", "sessions"),
  PARAWATCH_NOTIFY: "0",
};
Object.assign(process.env, env);

const { addProject, answerCard, claimSession, closeCard, commentCard, openCard } = await import("../src/core/ops.js");
const { eventsPath } = await import("../src/core/store.js");

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// ---------- projects ----------

const work = (name: string) => {
  const dir = path.join(root, "work", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const game = work("marble-box");
const app = work("ear-trainer");
const site = work("site");

// every event gets the age (minutes ago) listed here, in the order the events are written
const ages: number[] = [];
const at = (min: number, fn: () => unknown) => {
  fn();
  ages.push(min);
};

at(300, () => addProject("game", [game]));
at(300, () => addProject("app", [app]));
at(300, () => addProject("site", [site]));

// ---------- pictures ----------

const captures = path.join(root, "captures");
const picture = (name: string, w: number, h: number, body: string) => {
  const file = path.join(captures, name);
  write(file, `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
  return file;
};
const marbles = (cx: number, cy: number, n: number, spread: number, seed: number) => {
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const hues = [8, 38, 200, 140, 280, 350];
  let out = "";
  for (let i = 0; i < n; i++) {
    const x = cx + (rnd() - 0.5) * spread;
    const y = cy - rnd() * spread * 0.45;
    const r = 13 + rnd() * 5;
    const hue = hues[i % hues.length];
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${hue},70%,56%)"/><circle cx="${(x - r / 3).toFixed(1)}" cy="${(y - r / 3).toFixed(1)}" r="${(r / 3).toFixed(1)}" fill="white" opacity=".55"/>`;
  }
  return out;
};
const sideTank = picture(
  "side-tank.svg",
  800,
  500,
  `<rect width="800" height="500" fill="#20242c"/><rect x="0" y="420" width="800" height="80" fill="#2d323c"/>
  <rect x="420" y="150" width="260" height="270" rx="10" fill="#9fd3ff" opacity=".18" stroke="#cfe9ff" stroke-width="4"/>
  <path d="M120 120 L420 300" stroke="#cfe9ff" stroke-width="40" stroke-linecap="round" opacity=".14"/>
  ${marbles(550, 400, 26, 220, 7)}${marbles(260, 220, 5, 90, 3)}`,
);
const topBox = picture(
  "top-box.svg",
  800,
  500,
  `<rect width="800" height="500" fill="#20242c"/><rect x="0" y="420" width="800" height="80" fill="#2d323c"/>
  <rect x="260" y="200" width="280" height="220" rx="8" fill="#c9915a"/><rect x="250" y="180" width="300" height="30" rx="6" fill="#ddaa70"/>
  <path d="M250 180 L215 70 L520 70 L550 180 Z" fill="#b07a46" opacity=".9"/>
  ${marbles(400, 150, 14, 240, 11)}`,
);
const glass = picture(
  "glass.svg",
  480,
  720,
  `<rect width="480" height="720" fill="#1b1e24"/>
  <rect x="70" y="90" width="340" height="560" rx="16" fill="#9fd3ff" opacity=".14" stroke="#e4f3ff" stroke-width="5"/>
  <rect x="96" y="110" width="16" height="520" rx="8" fill="white" opacity=".35"/>
  ${marbles(240, 640, 40, 300, 5)}`,
);
const lesson = picture(
  "interval-lesson.svg",
  800,
  520,
  `<rect width="800" height="520" fill="#f6f7f9"/><rect x="40" y="40" width="720" height="440" rx="24" fill="white" stroke="#e3e6eb" stroke-width="2"/>
  <g stroke="#1f2329" stroke-width="2">${[0, 1, 2, 3, 4].map((i) => `<line x1="100" y1="${200 + i * 22}" x2="700" y2="${200 + i * 22}"/>`).join("")}</g>
  <ellipse cx="300" cy="266" rx="16" ry="11" fill="#1f2329"/><ellipse cx="420" cy="222" rx="16" ry="11" fill="#1f2329"/>
  <rect x="220" y="390" width="160" height="50" rx="25" fill="#2b6cf0"/><rect x="420" y="390" width="160" height="50" rx="25" fill="#e8ecf2"/>`,
);

// ---------- cards ----------

const GAME_LEAD = "7d3f9a12-4b5c-4e8d-9a1b-2c3d4e5f6a7b";
const APP_LEAD = "2e8c1b44-9d0a-4f6e-8b2c-5a7d9e1f3c60";
at(240, () => claimSession({ session: GAME_LEAD, project: "game", role: "lead", title: "Game Director" }));
at(240, () => claimSession({ session: APP_LEAD, project: "app", role: "lead", title: "App Director" }));

at(12, () =>
  openCard({
    kind: "decide",
    project: "game",
    task: "139",
    title: "Which ending for the shake box?",
    body: "Round 2 of the shake works. The letters appear once the marbles settle, so the ending decides what the player sees last.",
    options: ["Side tank: marbles pour in from the side", "Top box: the lid opens and they drop in", "Keep both and pick per level"],
    recommend: 2,
    attach: [sideTank, topBox],
    from: "Game Director",
    session: GAME_LEAD,
  }),
);
at(4, () =>
  openCard({
    kind: "try",
    project: "game",
    task: "139",
    title: "Try build 139: does the glass read as glass?",
    open: [path.join(game, "Builds", "MarbleBox.app")],
    look: "the tank walls when it is full, at the top right",
    attach: [glass],
    from: "Game Director",
    session: GAME_LEAD,
  }),
);
at(3, () => commentCard("c2", "Build is installed on this Mac.", "agent"));
at(64, () =>
  openCard({
    kind: "block",
    project: "app",
    title: "Install the iPad simulator runtime",
    body: "Xcode, Settings, Components, iOS 26.6 Simulator. The UI tests need it.",
    from: "App Director",
    session: APP_LEAD,
  }),
);
at(180, () =>
  openCard({
    kind: "todo",
    project: "site",
    title: "Renew the domain before the 20th",
    since: ago(60 * 24 * 3),
  }),
);
at(95, () =>
  openCard({
    kind: "decide",
    project: "app",
    title: "First lesson: intervals or rhythm?",
    options: ["Intervals", "Rhythm"],
    recommend: 1,
    attach: [lesson],
    from: "App Director",
    session: APP_LEAD,
  }),
);
at(41, () => answerCard("c5", { choice: 1, comment: "intervals, but keep it under two minutes", by: "human" }));
at(150, () =>
  openCard({
    kind: "decide",
    project: "game",
    title: "Marble count for level 1?",
    options: ["24", "40", "64"],
    recommend: 2,
    from: "Game Director",
    session: GAME_LEAD,
  }),
);
at(140, () => answerCard("c6", { choice: 2, by: "human" }));
at(120, () => closeCard("c6", "40 marbles, tuned for the small box"));

// rewrite the times so the board looks lived in
const lines = fs.readFileSync(eventsPath(), "utf8").trim().split("\n");
if (lines.length !== ages.length) throw new Error(`expected ${ages.length} events, found ${lines.length}`);
fs.writeFileSync(eventsPath(), lines.map((l, i) => JSON.stringify({ ...JSON.parse(l), ts: ago(ages[i]!) })).join("\n") + "\n");

// ---------- agent logs ----------

/** Minutes ago with activity: a list of [from, to] spans, newest last. */
type Spans = [number, number][];
const stamps = (spans: Spans) => spans.flatMap(([from, to]) => Array.from({ length: from - to + 1 }, (_, i) => from - i));

function claudeLog(file: string, o: { cwd: string; prompt: string; title?: string; spans: Spans; last: object }) {
  const recs: object[] = [];
  const mins = stamps(o.spans);
  recs.push({ type: "user", timestamp: ago(mins[0]! + 1), cwd: o.cwd, message: { role: "user", content: o.prompt } });
  if (o.title) recs.push({ type: "custom-title", customTitle: o.title });
  for (const m of mins.slice(0, -1)) {
    recs.push({ type: "assistant", timestamp: ago(m), cwd: o.cwd, message: { role: "assistant", content: [{ type: "tool_use", id: `t${m}`, name: "Read", input: { file_path: "/src/a.ts" } }] } });
    recs.push({ type: "user", timestamp: ago(m - 0.2), cwd: o.cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${m}`, content: "..." }] } });
  }
  recs.push({ timestamp: ago(mins.at(-1)!), cwd: o.cwd, ...o.last });
  write(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const bash = (description: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tb", name: "Bash", input: { command: "…", description } }] } });
const said = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

const claude = env.PARAWATCH_CLAUDE_DIR;
const gameDir = path.join(claude, "-work-marble-box");
const appDir = path.join(claude, "-work-ear-trainer");

claudeLog(path.join(gameDir, `${GAME_LEAD}.jsonl`), {
  cwd: game,
  prompt: "Lead the marble box work",
  spans: [[58, 50], [41, 30], [18, 12], [5, 0]],
  last: bash("Wait for answers"),
});
const sub = (dir: string, lead: string, id: string, description: string, spans: Spans, last: object) => {
  const file = path.join(dir, lead, "subagents", `agent-${id}.jsonl`);
  claudeLog(file, { cwd: game, prompt: description, spans, last });
  write(file.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ description, model: "sonnet" }));
};
sub(gameDir, GAME_LEAD, "a1b2c3d4e5f60718", "139 shake round 2", [[40, 22], [15, 0]], bash("Run tests"));
sub(gameDir, GAME_LEAD, "b2c3d4e5f6071829", "Glass shader pass", [[33, 9]], bash("Capture the tank"));
sub(gameDir, GAME_LEAD, "c3d4e5f60718293a", "Level 1 layout", [[55, 44]], said("Level 1 has 40 marbles and passes."));

claudeLog(path.join(appDir, `${APP_LEAD}.jsonl`), {
  cwd: app,
  prompt: "Lead the ear trainer work",
  spans: [[60, 52], [35, 31], [26, 24]],
  last: said("PR 18 passed. Waiting for the simulator runtime."),
});
claudeLog(path.join(appDir, "5f1e2d3c-4b5a-4968-8776-655443322110.jsonl"), {
  cwd: app,
  prompt: "Interval lesson screen",
  title: "Interval lesson screen",
  spans: [[47, 20], [12, 1]],
  last: bash("Build the app"),
});

// a codex exec job started from the game lead's scratch folder
const d = new Date(now);
const day = path.join(env.PARAWATCH_CODEX_DIR, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
const codexCwd = `/private/tmp/claude-501/-work-marble-box/${GAME_LEAD}/scratchpad/icons`;
const codexRecs: object[] = [
  { type: "session_meta", timestamp: ago(27), payload: { id: "019a-demo", cwd: codexCwd, originator: "codex_exec", source: "exec" } },
  { type: "response_item", timestamp: ago(27), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Generate the level icons" }] } },
  { type: "event_msg", timestamp: ago(27), payload: { type: "task_started" } },
  ...stamps([[26, 8], [6, 2]]).map((m) => ({ type: "response_item", timestamp: ago(m), payload: { type: "custom_tool_call", name: "exec", input: '{"cmd":"python3 make_icons.py"}' } })),
];
write(path.join(day, "rollout-demo-icons.jsonl"), codexRecs.map((r) => JSON.stringify(r)).join("\n") + "\n");

for (const [k, v] of Object.entries(env)) console.log(`export ${k}=${v}`);
