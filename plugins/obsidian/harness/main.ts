// Renders the panel in a plain browser page with fake cards and, when present, a real
// `parawatch status --json` snapshot. Answers are logged instead of sent.
import { Panel } from "../src/panel";
import type { Backend, Card, Reply, Snapshot } from "../src/types";

const now = Date.now();
const at = (min: number) => new Date(now - min * 60_000).toISOString();

const swatch = (label: string, hue: number) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="hsl(${hue},45%,35%)"/><circle cx="320" cy="230" r="120" fill="hsl(${hue},60%,70%)"/><text x="24" y="48" font-family="sans-serif" font-size="32" fill="white">${label}</text></svg>`,
  );

const cards: Card[] = [
  {
    id: "c4",
    kind: "decide",
    project: "game",
    task: "139",
    title: "Which ending for the shake box?",
    body: "Round 2 of the shake works. The letters appear once the marbles settle, so the ending decides what the player sees last.",
    options: ["Side tank: marbles pour in from the side", "Top box: the lid opens and they drop in", "Keep both and pick per level"],
    recommend: 2,
    attach: ["/captures/side-tank.png", "/captures/top-box.png"],
    from: "Game Director",
    openedAt: at(12),
    status: "open",
    answers: [],
    comments: [],
  },
  {
    id: "c5",
    kind: "try",
    project: "game",
    title: "Try build 139: does the glass read as glass?",
    open: ["/Applications/Game.app", "https://example.com/builds/139"],
    look: "the tank walls when it is full, at the top right",
    attach: ["/captures/glass.png"],
    openedAt: at(3),
    status: "open",
    answers: [],
    comments: [{ seq: 1, at: at(2), by: "agent", text: "Build is installed on this Mac." }],
  },
  {
    id: "c6",
    kind: "block",
    project: "app",
    title: "Install the iPad simulator runtime",
    body: "Xcode → Settings → Components → iOS 26.6 Simulator. The UI tests need it.",
    openedAt: at(64),
    status: "open",
    answers: [],
    comments: [],
  },
  {
    id: "c3",
    kind: "decide",
    project: "app",
    title: "Keep the coloured keyboard in practice mode?",
    options: ["Keep", "Drop"],
    openedAt: at(90),
    status: "answered",
    answers: [{ seq: 2, at: at(20), by: "human", choice: 1, comment: "Only for the first week" }],
    comments: [],
  },
];

const fakeRuns: Snapshot["runs"] = [
  { id: "lead-game", runtime: "claude-code", kind: "session", title: "Game Director", project: "game", role: "lead", state: "working", lastActivity: at(0.1), action: "Bash: Wait for answers" },
  { id: "s139", runtime: "claude-code", kind: "subagent", parent: "lead-game", title: "139 shake round 2", project: "game", model: "sonnet", state: "working", lastActivity: at(0.7), action: "Bash: Run the shake test scene" },
  { id: "x1", runtime: "codex", kind: "exec", parent: "lead-game", title: "Generate only the TODO icons", project: "game", state: "working", lastActivity: at(1), action: "exec: swift test" },
  { id: "s137", runtime: "claude-code", kind: "subagent", parent: "lead-game", title: "137 glass tank", project: "game", state: "done", lastActivity: at(8), action: "The tank fills to 60% width and 40% height." },
  { id: "s136", runtime: "claude-code", kind: "subagent", parent: "lead-game", title: "136 cup", project: "game", state: "done", lastActivity: at(31) },
  { id: "lead-app", runtime: "claude-code", kind: "session", title: "App Director", project: "app", role: "lead", state: "idle", lastActivity: at(25), action: "**PR101** passed native tests. Waiting for the runtime install before the UI run." },
  { id: "r1", runtime: "declared", kind: "declared", title: "PR101 CI, UI tests", project: "app", state: "working", lastActivity: at(6) },
  { id: "old", runtime: "claude-code", kind: "session", title: "A session in some notes folder", state: "stalled", lastActivity: at(45), action: "Bash: long benchmark" },
];

const media: Record<string, string> = {
  "/captures/side-tank.png": swatch("Side tank", 200),
  "/captures/top-box.png": swatch("Top box", 30),
  "/captures/glass.png": swatch("Glass, full", 170),
};

const log = (msg: string) => {
  const box = document.getElementById("log")!;
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  box.prepend(line);
};

async function load(): Promise<Snapshot> {
  let real: Snapshot | undefined;
  try {
    const res = await fetch("snapshot.json");
    if (res.ok) real = (await res.json()) as Snapshot;
  } catch {
    // no real snapshot next to the page
  }
  const useReal = new URLSearchParams(location.search).has("real") && real;
  return { v: 1, generatedAt: new Date().toISOString(), projects: real?.projects ?? [], cards: cards.filter((c) => c.status !== "closed"), runs: useReal ? real!.runs : fakeRuns };
}

const backend: Backend = {
  snapshot: load,
  async answer(card: string, reply: Reply) {
    log(`answer ${card} ${JSON.stringify(reply)}`);
    const c = cards.find((x) => x.id === card);
    if (c) {
      c.status = "answered";
      c.answers.push({ seq: 99, at: new Date().toISOString(), by: "human", ...reply });
    }
  },
  open: (t) => log(`open ${t}`),
  mediaUrl: async (f) => media[f],
  saveAttachment: async (_d, ext) => `/tmp/pasted.${ext}`,
  droppedPath: (f) => `/Users/me/Desktop/${f.name}`,
};

const root = document.getElementById("panel")!;
const panel = new Panel(root, backend, {
  renderMarkdown: (md, el) => {
    const p = document.createElement("p");
    p.textContent = md;
    el.appendChild(p);
  },
  icon: (el, name) => {
    el.dataset.icon = name;
    el.textContent = name === "refresh-cw" ? "↻" : name === "external-link" ? "↗" : "▫";
  },
  notice: (m) => log(`notice: ${m}`),
  refresh: () => void load().then((s) => panel.update(s)),
});
void load().then((s) => panel.update(s));
