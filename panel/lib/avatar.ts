// Each project's mark on the Projects page: a DiceBear "Shape Grid" made from
// its name (https://www.dicebear.com/styles/shape-grid/, CC0), so every
// project has one of its own. Drawn here as a data: URI; nothing is fetched.
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/shape-grid.json";

const style = new Style(definition);
const drawn = new Map<string, string>();

function draw(seed: string): string {
  let svg = drawn.get(seed);
  if (!svg) drawn.set(seed, (svg = new Avatar(style, { seed }).toString()));
  return svg;
}

/**
 * A mark for each slug, given oldest project first. A project whose mark would
 * look like an earlier one's gets the next variation of its name, so no two
 * look alike, and a new project never changes an older one's mark.
 */
export function projectMarks(slugs: string[]): Map<string, string> {
  const taken = new Set<string>();
  const marks = new Map<string, string>();
  for (const slug of slugs) {
    let svg = draw(slug);
    for (let i = 1; taken.has(svg) && i < 50; i++) svg = draw(`${slug}#${i}`);
    taken.add(svg);
    marks.set(slug, `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  }
  return marks;
}
