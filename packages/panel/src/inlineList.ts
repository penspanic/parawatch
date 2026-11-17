/**
 * Agents often number several points inside one line ("1) the camera. 2) the hand. 3) …").
 * Markdown shows that as one block, so such a line is broken before each number. Only a text
 * with no line break of its own, whose numbers run 1), 2), 3) in order, is changed.
 */
const MARKER = /(^|\s)(\d{1,2})[).]\s/g;

export function splitInlineList(text: string): string {
  if (text.includes("\n")) return text;
  const cuts: number[] = [];
  let next = 1;
  for (const m of text.matchAll(MARKER)) {
    if (Number(m[2]) !== next) continue;
    cuts.push(m.index! + m[1]!.length);
    next++;
  }
  if (cuts.length < 3) return text;
  const items = cuts.map((at, i) => text.slice(at, cuts[i + 1]).trim());
  // a lead-in sentence before "1)" stays a paragraph of its own
  const lead = text.slice(0, cuts[0]).trim();
  return (lead ? `${lead}\n\n` : "") + items.join("\n");
}
