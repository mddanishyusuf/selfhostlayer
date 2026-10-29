// Cron expressions → systemd OnCalendar. People know cron ("*/15 * * * *");
// systemd timers want "*-*-* *:00/15:00". The agent double-checks the result
// with `systemd-analyze calendar`, which also gives the next run time.

const PRESETS: Record<string, string> = {
  "@hourly": "hourly",
  "@daily": "daily",
  "@midnight": "daily",
  "@weekly": "weekly",
  "@monthly": "monthly",
  "@yearly": "yearly",
  "@annually": "yearly",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  namesStart?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesStart: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS.map((d) => d.toLowerCase()), namesStart: 0 },
];

function value(token: string, spec: FieldSpec): number {
  const named = spec.names?.indexOf(token.toLowerCase()) ?? -1;
  const n = named >= 0 ? named + (spec.namesStart ?? 0) : /^\d+$/.test(token) ? Number(token) : NaN;
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw new Error(`"${token}" isn't a valid ${spec.name} (${spec.min}-${spec.max})`);
  return n;
}

/** One cron field → the systemd form for numeric fields ("*", "5", "1,15", "9..17", "00/15", "9..17/2"). */
function numericField(field: string, spec: FieldSpec, pad: number): string {
  const fmt = (n: number) => String(n).padStart(pad, "0");
  return field
    .split(",")
    .map((part) => {
      const [range, stepText] = part.split("/");
      const step = stepText === undefined ? null : Number(stepText);
      if (stepText !== undefined && (!Number.isInteger(step) || step! < 1)) throw new Error(`"${part}": the step must be a positive number`);
      if (range === "*") return step ? `${fmt(spec.min)}/${step}` : "*";
      const [a, b] = range!.split("-");
      const start = value(a!, spec);
      if (b === undefined) return step ? `${fmt(start)}/${step}` : fmt(start);
      const end = value(b, spec);
      if (end < start) throw new Error(`"${part}": the range runs backwards`);
      return `${fmt(start)}..${fmt(end)}${step ? `/${step}` : ""}`;
    })
    .join(",");
}

/** Day-of-week field → "Mon..Fri" / "Sat,Sun" (0 and 7 are both Sunday). */
function weekdayField(field: string, spec: FieldSpec): string {
  return field
    .split(",")
    .map((part) => {
      if (part.includes("/")) throw new Error("Steps aren't supported in the day-of-week field");
      const [a, b] = part.split("-");
      const day = (n: number) => DAYS[n % 7]!;
      const start = value(a!, spec);
      if (b === undefined) return day(start);
      const end = value(b, spec);
      if (end < start) throw new Error(`"${part}": the range runs backwards`);
      return end === 7 && start === 0 ? "*" : `${day(start)}..${day(end)}`;
    })
    .join(",");
}

/**
 * Converts a 5-field cron expression (or @daily etc.) to OnCalendar.
 * Throws with a readable message for anything it can't express.
 */
export function cronToCalendar(expression: string): string {
  const text = expression.trim().replace(/\s+/g, " ");
  if (PRESETS[text.toLowerCase()]) return PRESETS[text.toLowerCase()]!;
  const fields = text.split(" ");
  if (fields.length !== 5) throw new Error("Use 5 fields: minute hour day-of-month month day-of-week (e.g. */15 * * * *), or @daily");
  if (!fields.every((f) => /^[\w*,\-/]+$/.test(f))) throw new Error("Only digits, names, * , - and / are allowed");
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  // Cron runs when EITHER day field matches if both are set; systemd needs both. Refuse the ambiguous case.
  if (dom !== "*" && dow !== "*") throw new Error("Set either the day of month or the day of week, not both");

  const minutePart = numericField(minute, FIELDS[0]!, 2);
  const hourPart = numericField(hour, FIELDS[1]!, 2);
  const domPart = numericField(dom, FIELDS[2]!, 2);
  const monthPart = numericField(month, FIELDS[3]!, 2);
  const dowPart = dow === "*" ? "" : `${weekdayField(dow, FIELDS[4]!)} `;
  return `${dowPart}*-${monthPart}-${domPart} ${hourPart}:${minutePart}:00`.replace(/^\* /, "");
}

/** A short human description for the common shapes, else the expression itself. */
export function describeCron(expression: string): string {
  const t = expression.trim().replace(/\s+/g, " ");
  const known: Record<string, string> = {
    "* * * * *": "every minute",
    "@hourly": "every hour",
    "@daily": "every day at 00:00",
    "@midnight": "every day at 00:00",
    "@weekly": "every Monday at 00:00",
    "@monthly": "on the 1st of every month",
  };
  if (known[t]) return known[t]!;
  let m = /^\*\/(\d+) \* \* \* \*$/.exec(t);
  if (m) return `every ${m[1]} minutes`;
  m = /^(\d+) \* \* \* \*$/.exec(t);
  if (m) return `every hour at :${m[1]!.padStart(2, "0")}`;
  m = /^(\d+) (\d+) \* \* \*$/.exec(t);
  if (m) return `every day at ${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
  return t;
}

/** A timestamp from `systemctl show` ("Thu 2026-10-29 13:00:00 UTC") in ms; null for "n/a" or a zone other than UTC. */
export function parseSystemdTime(value: string | null): number | null {
  const m = /^(?:\w{3} )?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|GMT)$/.exec(value?.trim() ?? "");
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : null;
}
