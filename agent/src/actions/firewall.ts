// Read-only view of the firewall: ufw's rules and fail2ban's bans.
// ufw is read from its own rule files: the agent has no CAP_NET_ADMIN, so it
// can't ask iptables, and the files are the source of truth anyway.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionTable, Context, Params } from "../context.ts";
import { BIN } from "../exec.ts";

export interface FirewallRule {
  action: string;
  protocol: string;
  port: string;
  from: string;
  ipv6: boolean;
  comment: string | null;
}

/** "### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in comment=737368" lines. */
export function parseUfwRules(text: string, ipv6: boolean): FirewallRule[] {
  const rules: FirewallRule[] = [];
  for (const line of text.split("\n")) {
    const m = /^### tuple ### (\w+) (\w+) (\S+) \S+ \S+ (\S+) (in|out)(?: comment=([0-9a-f]+))?/.exec(line.trim());
    if (!m || m[5] !== "in") continue;
    const comment = m[6] ? Buffer.from(m[6], "hex").toString("utf8") : null;
    rules.push({ action: m[1]!, protocol: m[2]!, port: m[3]!, from: /^(0\.0\.0\.0\/0|::\/0)$/.test(m[4]!) ? "Anywhere" : m[4]!, ipv6, comment });
  }
  return rules;
}

export interface Jail {
  name: string;
  currentlyFailed: number;
  totalFailed: number;
  currentlyBanned: number;
  totalBanned: number;
  banned: string[];
}

export function parseJailList(text: string): string[] {
  const m = /Jail list:\s*(.*)$/m.exec(text);
  return m ? m[1]!.split(",").map((j) => j.trim()).filter(Boolean) : [];
}

export function parseJail(name: string, text: string): Jail {
  const num = (label: string) => Number(new RegExp(`${label}:\\s*(\\d+)`).exec(text)?.[1] ?? 0);
  const list = /Banned IP list:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  return {
    name,
    currentlyFailed: num("Currently failed"),
    totalFailed: num("Total failed"),
    currentlyBanned: num("Currently banned"),
    totalBanned: num("Total banned"),
    banned: list ? list.split(/\s+/) : [],
  };
}

async function firewallStatus(_params: Params, ctx: Context) {
  const dir = ctx.paths.ufwDir;
  const conf = join(dir, "ufw.conf");
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const ufw = {
    installed: existsSync(conf),
    enabled: /^ENABLED=yes$/m.test(existsSync(conf) ? readFileSync(conf, "utf8") : ""),
    rules: [...parseUfwRules(read("user.rules"), false), ...parseUfwRules(read("user6.rules"), true)],
  };

  const list = await ctx.exec(BIN.fail2banClient, ["status"], { allowFail: true, timeoutMs: 10_000 });
  const jails: Jail[] = [];
  if (list.code === 0) {
    for (const name of parseJailList(list.stdout)) {
      const r = await ctx.exec(BIN.fail2banClient, ["status", name], { allowFail: true, timeoutMs: 10_000 });
      if (r.code === 0) jails.push(parseJail(name, r.stdout));
    }
  }
  return { ufw, fail2ban: { running: list.code === 0, jails } };
}

export const firewallActions: ActionTable = {
  "firewall.status": { mutates: false, run: firewallStatus },
};
