import { describe, expect, it } from "vitest";
import { isRunTitles, runLabel } from "../src/runTitle";
import type { Run } from "../src/types";

const run = (over: Partial<Run>): Run => ({ id: "s1", runtime: "claude-code", kind: "session", state: "working", title: "t", ...over }) as Run;

describe("runLabel", () => {
  const director = run({ title: "Model and launch", name: "Spill Director", work: "Model and launch" });
  it("shows both by default, the name first", () => {
    expect(runLabel(director, "both")).toEqual({ main: "Spill Director", work: "Model and launch" });
  });
  it("shows one when asked", () => {
    expect(runLabel(director, "name")).toEqual({ main: "Spill Director" });
    expect(runLabel(director, "work")).toEqual({ main: "Model and launch" });
  });
  it("falls back to the title when a run has no name or no work, as from an older machine", () => {
    const old = run({ title: "Model and launch" });
    for (const m of ["both", "name", "work"] as const) expect(runLabel(old, m)).toEqual({ main: "Model and launch" });
    expect(runLabel(run({ title: "Spill Director", name: "Spill Director" }), "work")).toEqual({ main: "Spill Director" });
  });
  it("does not repeat a work that is the name", () => {
    expect(runLabel(run({ title: "Director", name: "Director", work: "Director" }), "both")).toEqual({ main: "Director" });
  });
  it("knows its modes", () => {
    expect(isRunTitles("both")).toBe(true);
    expect(isRunTitles("title")).toBe(false);
  });
});
