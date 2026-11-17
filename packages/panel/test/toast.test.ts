// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeToast } from "../src/toast";

describe("toast", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the message with a Copy button that copies what it names", async () => {
    document.body.innerHTML = '<div id="toast"></div>';
    const box = document.getElementById("toast")!;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const toast = makeToast(box);
    toast("X is not on this machine yet.", "E:\\dev\\x");
    expect(box.classList.contains("is-shown")).toBe(true);
    expect(box.querySelector(".pw-toast-text")?.textContent).toBe("X is not on this machine yet.");
    const copy = box.querySelector<HTMLButtonElement>(".pw-toast-copy")!;
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("E:\\dev\\x");
    expect(copy.textContent).toBe("Copied");
  });

  it("copies the message itself when nothing else is named, and hides after a while unless held", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="toast"></div>';
    const box = document.getElementById("toast")!;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const toast = makeToast(box, 1000);
    toast("Could not open it");
    box.querySelector<HTMLButtonElement>(".pw-toast-copy")!.click();
    expect(writeText).toHaveBeenCalledWith("Could not open it");
    box.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(1500);
    expect(box.classList.contains("is-shown")).toBe(true);
    box.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(1600);
    expect(box.classList.contains("is-shown")).toBe(false);
  });
});
