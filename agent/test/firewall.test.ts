import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firewallActions, parseJail, parseJailList, parseUfwRules } from "../src/actions/firewall.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

const USER_RULES = `*filter
### RULES ###

### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in comment=737368
-A ufw-user-input -p tcp --dport 22 -j ACCEPT -m comment --comment 'dapp_ssh'

### tuple ### allow tcp 443 0.0.0.0/0 any 0.0.0.0/0 in comment=6874747073
### tuple ### allow udp 443 0.0.0.0/0 any 0.0.0.0/0 in comment=6874747033
### tuple ### deny tcp 3306 0.0.0.0/0 any 10.0.0.0/8 in
### END RULES ###`;

const SSHD = `Status for the jail: sshd
|- Filter
|  |- Currently failed:\t2
|  |- Total failed:\t31
|  \`- Journal matches:\t_SYSTEMD_UNIT=ssh.service + _COMM=sshd
\`- Actions
   |- Currently banned:\t2
   |- Total banned:\t9
   \`- Banned IP list:\t185.220.101.47 45.148.10.243`;

describe("firewall parsing", () => {
  it("reads ufw's rule tuples, with comments and sources", () => {
    expect(parseUfwRules(USER_RULES, false)).toEqual([
      { action: "allow", protocol: "tcp", port: "22", from: "Anywhere", ipv6: false, comment: "ssh" },
      { action: "allow", protocol: "tcp", port: "443", from: "Anywhere", ipv6: false, comment: "https" },
      { action: "allow", protocol: "udp", port: "443", from: "Anywhere", ipv6: false, comment: "http3" },
      { action: "deny", protocol: "tcp", port: "3306", from: "10.0.0.0/8", ipv6: false, comment: null },
    ]);
  });

  it("reads fail2ban's jail list and a jail's bans", () => {
    expect(parseJailList("Status\n|- Number of jail:\t2\n`- Jail list:\tsshd, layer-panel")).toEqual(["sshd", "layer-panel"]);
    expect(parseJail("sshd", SSHD)).toEqual({ name: "sshd", currentlyFailed: 2, totalFailed: 31, currentlyBanned: 2, totalBanned: 9, banned: ["185.220.101.47", "45.148.10.243"] });
  });
});

describe("firewall.status", () => {
  let env: TestEnv;
  beforeEach(() => (env = testEnv()));
  afterEach(() => env.cleanup());

  it("combines ufw's files with fail2ban's answers", async () => {
    mkdirSync(env.paths.ufwDir, { recursive: true });
    writeFileSync(join(env.paths.ufwDir, "ufw.conf"), "ENABLED=yes\nLOGLEVEL=low\n");
    writeFileSync(join(env.paths.ufwDir, "user.rules"), USER_RULES);
    env.fake.respond = (file, args) =>
      file === BIN.fail2banClient ? { code: 0, stdout: args.length === 1 ? "`- Jail list:\tsshd" : SSHD, stderr: "" } : undefined;
    const r = (await firewallActions["firewall.status"]!.run({}, env.ctx, NO_IO)) as any;
    expect(r.ufw).toMatchObject({ installed: true, enabled: true });
    expect(r.ufw.rules).toHaveLength(4);
    expect(r.fail2ban.jails[0].banned).toEqual(["185.220.101.47", "45.148.10.243"]);
  });

  it("works without ufw or fail2ban", async () => {
    env.fake.respond = (file) => (file === BIN.fail2banClient ? { code: 1, stdout: "", stderr: "not running" } : undefined);
    const r = (await firewallActions["firewall.status"]!.run({}, env.ctx, NO_IO)) as any;
    expect(r).toEqual({ ufw: { installed: false, enabled: false, rules: [] }, fail2ban: { running: false, jails: [] } });
  });
});
