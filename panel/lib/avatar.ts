// Each project's mark on the Projects page: an icon for what the project is,
// white on a colored tile, from DiceBear's "Icons" style (Bootstrap Icons,
// MIT: https://www.dicebear.com/styles/icons/). The icon comes from the words
// in the project's name (reduce-png-size gets a camera, superdevdocs a book,
// post-schedulers a clock); a name that says nothing gets one that fits
// anything. The tile's color comes from the name too, and looks right in both
// themes. Drawn here as a data: URI; nothing is fetched.
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/icons.json";

// DiceBear draws the icon twice, blended into a pastel tile; here it's drawn once, solid.
/** The icons DiceBear has (alarm … webcam): the table below is checked against them. */
type IconName = keyof typeof definition.components.icon.variants;

const style = new Style({ ...definition, canvas: { ...definition.canvas, elements: [{ name: "g", type: "element", attributes: { transform: "translate(4 4)" }, children: [{ name: "icon", type: "component" }] }] } });

/**
 * What a name can say, and its icons, best first. The first topic with a word
 * in the name wins, so specific ones come first and generic words (company,
 * website) last. A word matches a part of the name (split at dashes and
 * digits) when it's the whole part, or, from 4 letters, its start or end
 * (superdevdocs: docs), or from 5 anywhere in it (trafficsource: traffic).
 * A 3-letter word matches the start or end of a part of 7 letters or more
 * (payonceuseforever: pay), so pic doesn't find picker.
 */
const TOPICS: [icons: IconName[], words: string][] = [
  [["magic", "lightbulb"], "ai gpt chatgpt llm llms openai claude agent agents copilot assistant chatbot bot bots automate automation ml"],
  [["camera", "easel"], "image images img png jpg jpeg webp svg photo photos photography picture pictures pics gallery screenshot screenshots compress compressor resize resizer"],
  [["cameraReels", "projector"], "video videos film films movie movies reel reels youtube stream streaming"],
  [["boombox", "speaker"], "music song songs audio sound sounds podcast podcasts radio beats playlist spotify"],
  [["palette", "palette2", "paintBucket", "brush", "easel"], "design designs designer figma color colors colour colours palette theme themes picker paint painting drawing sketch arts artist artwork logo logos icon icons font fonts ui ux uikit css"],
  [["envelope", "mailbox", "inbox"], "mail email emails newsletter newsletters smtp mailer"],
  [["pencil", "pen"], "notes note notebook journal diary write writer writing author authors article articles paper papers kagaz markdown editor text copywriting content"],
  [["book", "bookshelf"], "docs doc documentation wiki guide guides manual handbook readme knowledge faq helpdesk ebook books reading"],
  [["mortarboard", "book"], "learn learning course courses school class classes academy edu lms tutor tutorial tutorials study lesson lessons flashcards quiz"],
  [["globe2", "book"], "translate translator translation language languages dictionary i18n locale locales"],
  [["newspaper"], "news blog blogs magazine changelog wordpress rss feeds digest ghost substack"],
  [["send"], "chat message messages messenger sms whatsapp telegram discord slack talk"],
  [["stoplights", "bell"], "status uptime monitor monitoring incident incidents healthcheck"],
  [["clock", "alarm", "hourglass", "stopwatch"], "schedule scheduler schedulers scheduling calendar calendly calcom booking bookings appointment appointments cron timer time clock reminder reminders deadline pomodoro timezone timezones countdown"],
  [["megaphone", "send"], "social twitter tweet tweets facebook instagram linkedin tiktok reddit forum forums discussion discussions marketing advertising adverts campaign campaigns launch launches announce promo posts posting community"],
  [["handThumbsUp", "star"], "feedback reviews rating ratings testimonial testimonials comments vote votes upvote"],
  [["inbox", "inboxes", "pencil"], "forms survey surveys poll polls signup register rsvp typeform"],
  [["hourglass", "ticketPerforated"], "waitlist waitlists queue"],
  [["paperclip"], "link links url urls shortener shorten shortlink shortlinks redirect bio linkinbio bitly"],
  [["signpostSplit", "signpost2"], "traffic referrer referrers sources utm"],
  [["binoculars", "search"], "analytics stats metrics insight insights visitors dashboard reports kpi posthog plausible umami"],
  [["bell"], "notify notification notifications alert alerts push"],
  [["pinAngle", "flag"], "todo todos task tasks kanban checklist planner plans habit habits goal goals okr"],
  [["calculator"], "calculator calc convert converter math estimate estimator"],
  [["cashCoin", "piggyBank", "coin", "bank"], "pay payment payments paypal stripe billing invoice invoices price pricing money cash finance fintech budget expense expenses bank banking coin crypto bitcoin donate donation subscription subscriptions revenue sales credit credits salary tax"],
  [["shop", "cart2", "bag", "basket", "shopWindow"], "shop storefront stores cart commerce ecommerce market marketplace sell seller buy merch shopify pos"],
  [["boxSeam", "boxes"], "inventory warehouse"],
  [["briefcase"], "jobs job hire hiring career careers resume portfolio recruit recruiting talent freelance freelancer crm contacts leads clients customers"],
  [["boxes", "boxSeam", "box"], "stack stacks kit kits starter starters boilerplate template templates blocks components library"],
  [["bricks", "ladder"], "building build builder builders maker makers indie indiehacker solo bootstrap bootstrapped startup startups mvp saas"],
  [["laptop", "display"], "mac macos macapp menubar desktop laptop osx windows"],
  [["phone", "tablet"], "ios iphone android mobile phone ipad tablet"],
  [["smartwatch"], "watch wearable"],
  [["keyboard", "mouse2"], "dev devs developer developers devtools code coding ide snippet snippets terminal cli script scripts github gitlab repo compiler backend frontend"],
  [["plug", "puzzle"], "plugin plugins extension extensions integration integrations connect connector webhook webhooks api apis sdk zapier"],
  [["router", "hdd", "cloud"], "server servers host hosting selfhost homelab deploy infra vps cloud devops docker kubernetes proxy dns cdn network vpn wifi"],
  [["hdd", "sdCard", "archive", "disc"], "disk drive storage backup backups upload uploads sharing transfer dropbox archive archives database db sql sqlite postgres mysql mongo redis data"],
  [["lock", "key"], "security secure auth login password passwords vault secret secrets lock privacy private encrypt otp gdpr consent cookie cookies"],
  [["key"], "license licenses key keys"],
  [["bug"], "bug bugs issue issues error errors debug sentry crash"],
  [["controller", "dpad", "dice5"], "game games gaming gamer arcade chess tetris"],
  [["dice5"], "dice random luck lottery raffle giveaway"],
  [["puzzle"], "puzzle puzzles riddle sudoku crossword"],
  [["trophy", "award"], "award awards trophy win winner winners contest challenge challenges leaderboard producthunt league champion"],
  [["gift", "ticketPerforated"], "gift gifts reward rewards referral referrals coupon coupons deal deals"],
  [["ticketPerforated"], "event events ticket tickets meetup meetups conference"],
  [["house", "houseDoor", "doorOpen"], "home homes house houses rental rentals estate realestate property properties apartment apartments airbnb rooms"],
  [["map", "compass", "signpost"], "travel trip trips vacation holiday hotel hotels flight flights map maps geo location locations locator places city cities"],
  [["cloudDrizzle", "clouds", "sun"], "weather forecast climate"],
  [["tree", "flower1", "flower2"], "eco green plant plants garden gardening tree trees forest nature carbon flower flowers florist"],
  [["moonStars"], "meditation mindful mindfulness calm sleep relax"],
  [["heart"], "love dating wedding charity health healthy medical doctor clinic care pet pets dogs cats adoption"],
  [["stopwatch", "heart"], "fitness gym workout yoga running"],
  [["scissors"], "salon barber barbershop haircut beauty"],
  [["cupStraw", "eggFried"], "food recipe recipes kitchen restaurant cafe coffee drinks bakery pizza burger"],
  [["truck", "truckFlatbed"], "delivery deliveries shipping logistics fleet courier moving movers truck trucks"],
  [["bicycle"], "bike bikes bicycle cycling"],
  [["umbrella"], "insurance insure"],
  [["search", "compass"], "search seo find finder lookup discover explore directory"],
  [["printer"], "print printer pdf"],
  [["lightning", "lightningCharge"], "fast quick speed rapid turbo instant flash boost power"],
  [["lightbulb"], "idea ideas brainstorm brain"],
  [["magic", "scissors"], "tools tool toolkit toolbox utils utility utilities helper helpers"],
  [["star"], "star stars fav favorite favorites favourite"],
  [["building", "briefcase"], "company agency studio business corp inc llc hq office team teams enterprise consulting"],
  [["globe", "globe2", "display"], "website websites site sites web landing homepage www page pages com net org io me personal"],
];
/** For names that say nothing: icons that fit anything. */
const ANYTHING: IconName[] = ["star", "gem", "lightbulb", "compass", "flag", "sun", "moonStars", "flower1", "heart", "key", "gift", "award", "magic", "trophy", "lightning", "puzzle"];
/** Tiles bright enough to read as colors in both themes, each dark enough for a white icon (3:1 or more). */
const COLORS = ["#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#ea580c", "#d97706", "#65a30d", "#059669", "#0d9488", "#0891b2", "#0284c7"];

const TABLE = TOPICS.map(([icons, words]) => [icons, words.split(" ")] as const);
const fits = (part: string, word: string) =>
  part === word ||
  (word.length >= 4 && (part.startsWith(word) || part.endsWith(word))) ||
  (word.length >= 5 && part.includes(word)) ||
  (word.length === 3 && part.length >= 7 && (part.startsWith(word) || part.endsWith(word)));

/** The icons that fit a name, best first; ANYTHING when it says nothing. */
export function iconsFor(name: string): readonly IconName[] {
  const parts = name.toLowerCase().split(/[^a-z]+/).filter((p) => p.length >= 2);
  for (const [icons, words] of TABLE) if (parts.some((p) => words.some((w) => fits(p, w)))) return icons;
  return ANYTHING;
}

/** FNV-1a: the same number for a name on every server. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Each slug's icon and color, given oldest project first. A project takes the
 * best icon for its name that no older project has (picker-design-website
 * gets palette2 when design-tools has palette); when they're all taken, the
 * best one in a color no older project shows it in. Colors go round evenly
 * (the name picks among the least used), so no two look alike, and a new
 * project never changes an older one's mark.
 */
export function pickMarks(slugs: string[]): Map<string, { icon: IconName; color: string }> {
  const icons = new Set<IconName>();
  const looks = new Set<string>();
  const used = COLORS.map(() => 0);
  const picks = new Map<string, { icon: IconName; color: string }>();
  for (const slug of slugs) {
    const h = hash(slug);
    const fit = iconsFor(slug);
    // A name that says nothing starts anywhere in ANYTHING, so those don't all get a star.
    const start = fit === ANYTHING ? h % fit.length : 0;
    const order = fit.map((_, i) => fit[(start + i) % fit.length]!);
    const icon = order.find((i) => !icons.has(i)) ?? order[0]!;
    // The least used color this icon doesn't have yet, so the list stays varied.
    // 5 steps round the colors reach every one, each far from the last.
    let c = h % COLORS.length;
    let best = -1;
    for (let i = 0, k = c; i < COLORS.length; i++, k = (k + 5) % COLORS.length) {
      if (looks.has(`${icon} ${k}`)) continue;
      if (best < 0 || used[k]! < used[best]!) best = k;
    }
    if (best >= 0) c = best;
    used[c]!++;
    icons.add(icon);
    looks.add(`${icon} ${c}`);
    picks.set(slug, { icon, color: COLORS[c]! });
  }
  return picks;
}

const drawn = new Map<string, string>();
function draw(icon: IconName, color: string): string {
  const key = `${icon} ${color}`;
  let uri = drawn.get(key);
  if (!uri) {
    const svg = new Avatar(style, { seed: icon, iconVariant: icon, iconColor: "#ffffff", backgroundColor: color, scale: 0.85 }).toString();
    drawn.set(key, (uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`));
  }
  return uri;
}

/** A mark (a data: URI) for each slug, given oldest project first. */
export function projectMarks(slugs: string[]): Map<string, string> {
  return new Map([...pickMarks(slugs)].map(([slug, { icon, color }]) => [slug, draw(icon, color)]));
}
