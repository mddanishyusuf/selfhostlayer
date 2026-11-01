// Each project's mark on the Projects page: a DiceBear "Slice" made from its
// name (https://www.dicebear.com/styles/slice/, CC0), so every project has one
// of its own. In greys: darker slices on a light tile, which light mode
// inverts (--mark-filter), as AgentOS's project tile is white in dark and
// black in light. Drawn here as a data: URI; nothing is fetched.
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/slice.json";

const style = new Style(definition);
/** The tile a little lighter or darker, and slices dark enough to read on it. */
const GREYS = { backgroundColor: ["f4f4f4", "ececec", "e4e4e4"], bodyColor: ["262626", "333333", "404040", "4d4d4d", "5c5c5c", "6b6b6b"] };
const drawn = new Map<string, string>();

function draw(seed: string): string {
  let svg = drawn.get(seed);
  if (!svg) drawn.set(seed, (svg = new Avatar(style, { seed, ...GREYS }).toString()));
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
