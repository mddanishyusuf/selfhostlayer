// What a click's User-Agent says: a bot or a person, and the device, browser
// and OS. A short list of rules for the common cases, not a full parser:
// stats need "Chrome on Android", not a version number.

export interface Agent {
  bot: boolean;
  device: "desktop" | "mobile" | "tablet" | "other";
  browser: string;
  os: string;
}

// Crawlers, link previews (chat apps fetch a link when it's pasted), monitors
// and HTTP libraries. "cubot" is a phone maker, not a bot. LinkedIn, X,
// Telegram and Pinterest aren't named: their apps' own browsers say so, and
// their crawlers (LinkedInBot, Twitterbot, TelegramBot, Pinterestbot) are bots anyway.
const BOT =
  /bot\b|bot\/|crawl|spider|slurp|scrap|archiv|preview|monitor|uptime|pingdom|statuscake|check|scan|validator|lighthouse|pagespeed|headless|phantom|puppeteer|playwright|selenium|curl|wget|httpie|python|java\/|go-http|okhttp|axios|node-fetch|undici|libwww|perl|ruby|php\/|facebookexternalhit|facebot|whatsapp|discord|slack|skype|embedly|vkshare|quora|redditbot|bingpreview|yandex|baidu|duckduck|petal|semrush|ahrefs|mj12|dotbot|bytespider|gptbot|claude|perplexity|cohere|ccbot|applebot|google-inspectiontool|feedfetcher|rss|feed/i;

const BROWSERS: [RegExp, string][] = [
  [/Instagram/, "Instagram"],
  [/FBAN|FBAV|FB_IAB/, "Facebook"],
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/YaBrowser/, "Yandex"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/Chrome\/|CriOS/, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

export function readAgent(ua: string | undefined): Agent {
  // Real ones are under 300 characters; a longer one only makes the rules slow (some backtrack).
  const text = (ua ?? "").slice(0, 512);
  const bot = !text.trim() || (BOT.test(text) && !/cubot/i.test(text));
  const browser = BROWSERS.find(([re]) => re.test(text))?.[1] ?? "Other";
  const os = SYSTEMS.find(([re]) => re.test(text))?.[1] ?? "Other";
  const device =
    /iPad|Tablet/.test(text) || (/Android/.test(text) && !/Mobile/.test(text))
      ? "tablet"
      : /Mobi|iPhone|iPod/.test(text)
        ? "mobile"
        : ["Windows", "macOS", "Linux", "ChromeOS"].includes(os)
          ? "desktop"
          : "other";
  return { bot, device, browser, os };
}

/** The referring site's host, without www. (null when there's none, or it's this domain). */
export function referrerHost(referer: string | undefined, ownHost: string | undefined): string | null {
  if (!referer) return null;
  try {
    const host = new URL(referer).hostname.toLowerCase().replace(/^www\./, "");
    const own = ownHost?.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
    return host && host !== own ? host.slice(0, 253) : null;
  } catch {
    return null;
  }
}
