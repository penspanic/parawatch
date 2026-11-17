import { describe, expect, it } from "vitest";
import { splitInlineList } from "../src/inlineList";

describe("splitInlineList", () => {
  it("breaks a one-line numbered list before each number", () => {
    expect(splitInlineList("1) the camera. 2) the hand. 3) the pocket.")).toBe("1) the camera.\n2) the hand.\n3) the pocket.");
  });

  it("keeps a lead-in sentence as its own paragraph", () => {
    expect(splitInlineList("Look at: 1) one 2) two 3) three")).toBe("Look at:\n\n1) one\n2) two\n3) three");
  });

  it("takes 1. 2. 3. as well", () => {
    expect(splitInlineList("1. one 2. two 3. three")).toBe("1. one\n2. two\n3. three");
  });

  it("skips numbers out of order", () => {
    expect(splitInlineList("1) board 22 and 5) mid 2) two 3) three")).toBe("1) board 22 and 5) mid\n2) two\n3) three");
  });

  it("leaves text that already has line breaks", () => {
    const text = "1) one 2) two 3) three\nmore";
    expect(splitInlineList(text)).toBe(text);
  });

  it("leaves fewer than three numbers alone", () => {
    expect(splitInlineList("pick 1) or 2) today")).toBe("pick 1) or 2) today");
  });

  it("does not take a number glued to a word", () => {
    expect(splitInlineList("v1) a2) b3) c")).toBe("v1) a2) b3) c");
  });
});
