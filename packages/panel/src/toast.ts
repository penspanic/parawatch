/**
 * The short message at the bottom of the window. It carries a Copy button, since a message often
 * names a path, a command or an error the human wants to paste somewhere. It stays while the
 * pointer is on it.
 */
export function makeToast(box: HTMLElement, ms = 5000): (text: string, copy?: string) => void {
  let timer: number | undefined;
  let held = false;
  const win = box.ownerDocument.defaultView!;
  const hide = () => {
    timer = undefined;
    if (!held) box.classList.remove("is-shown");
  };
  box.addEventListener("pointerenter", () => {
    held = true;
  });
  box.addEventListener("pointerleave", () => {
    held = false;
    if (timer === undefined) timer = win.setTimeout(hide, 1500);
  });

  return (text: string, copy?: string) => {
    box.replaceChildren();
    const doc = box.ownerDocument;
    const line = doc.createElement("span");
    line.className = "pw-toast-text";
    line.textContent = text;
    const button = doc.createElement("button");
    button.className = "pw-toast-copy";
    button.textContent = "Copy";
    button.title = copy && copy !== text ? `Copy ${copy}` : "Copy this message";
    button.onclick = () => {
      void win.navigator.clipboard.writeText(copy ?? text).then(
        () => {
          button.textContent = "Copied";
        },
        () => {
          button.textContent = "Could not copy";
        },
      );
    };
    box.append(line, button);
    box.classList.add("is-shown");
    if (timer !== undefined) win.clearTimeout(timer);
    timer = win.setTimeout(hide, ms);
  };
}
