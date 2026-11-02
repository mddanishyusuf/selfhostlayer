import { describe, expect, it } from "vitest";
import { assertSiteUrl, assertWordpressVersion, newSalts, renderWpConfig, renderWpCronUnits, wordpressBlocks, type WordpressState } from "../src/templates/wordpress.ts";

const db = { database: "app_blog", user: "app_blog", password: "abc123" };
const state: WordpressState = { version: "7.1.4", url: "https://blog.example.com", salts: newSalts(), locked: false, xmlrpc: false, mail: null };

describe("wp-config.php", () => {
  it("has the database, fresh salts, the address and the defaults", () => {
    const c = renderWpConfig(state, db);
    expect(c).toContain("define('DB_PASSWORD', 'abc123');");
    expect(c).toContain("define('DB_HOST', '127.0.0.1:3306');");
    expect(c).toContain("define('WP_HOME', 'https://blog.example.com');");
    expect(c).toContain("define('DISABLE_WP_CRON', true);");
    expect(c).toContain("define('DISALLOW_FILE_EDIT', true);");
    expect(c).toContain("define('DISALLOW_FILE_MODS', false);");
    expect(c).toContain("define('FORCE_SSL_ADMIN', true);");
    expect(Object.values(state.salts).every((v) => v.length === 64 && /^[A-Za-z0-9_-]+$/.test(v))).toBe(true);
  });

  it("escapes what it writes into PHP strings", () => {
    const c = renderWpConfig({ ...state, locked: true, mail: { kind: "smtp", host: "smtp.example.com", port: 587, user: "me", password: "it's\\here'); system('x", secure: "tls", from: "a@b.co" } }, db);
    expect(c).toContain("define('LAYER_SMTP_PASSWORD', 'it\\'s\\\\here\\'); system(\\'x');");
    expect(c).toContain("define('DISALLOW_FILE_MODS', true);");
  });

  it("checks versions and addresses", () => {
    expect(assertWordpressVersion("7.1.4")).toBe("7.1.4");
    expect(() => assertWordpressVersion("7.1.4; rm")).toThrow();
    expect(() => assertSiteUrl("https://x.com/path")).toThrow();
    expect(() => assertSiteUrl("javascript:alert(1)")).toThrow();
  });

  it("blocks xmlrpc unless asked, and runs WP-Cron as the site", () => {
    expect(wordpressBlocks(false)).toContain("/xmlrpc.php");
    expect(wordpressBlocks(true)).not.toContain("/xmlrpc.php");
    const { service, timer } = renderWpCronUnits("blog", "/opt/layer/tools/wp-cli/2.12.0/wp-cli.phar");
    expect(service).toContain("User=app-blog");
    expect(service).toContain("cron event run --due-now");
    expect(timer).toContain("OnCalendar=*:0/5");
  });
});
