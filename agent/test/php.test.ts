import { describe, expect, it } from "vitest";
import { parseLiveMarker } from "../src/templates/caddy-site.ts";
import { assertBlocks, assertPhpSettings, renderPhpFpmConf, renderPhpSite, renderPhpUnit } from "../src/templates/php.ts";

const settings = assertPhpSettings({ root: "wordpress", private: ["wp-config.php"] });

describe("PHP templates", () => {
  it("keeps PHP inside the site, with no workers when idle", () => {
    const conf = renderPhpFpmConf("blog", settings, "/run/layer-php");
    expect(conf).toContain("listen = /run/layer-php/blog/php.sock");
    expect(conf).toContain("pm = ondemand");
    expect(conf).toContain("php_admin_value[open_basedir] = /srv/apps/blog/data/wordpress/:/tmp/");
    expect(conf).toContain("disable_functions] = exec,passthru,shell_exec,system,proc_open,popen");
  });

  it("runs FPM as the site, sandboxed, with root's config handed over read-only", () => {
    const unit = renderPhpUnit("blog", settings, "/usr/sbin/php-fpm8.3", "/run/layer-php", "caddy");
    expect(unit).toContain("User=app-blog");
    expect(unit).toContain("LoadCredential=php-fpm.conf:/etc/layer/apps/blog/php-fpm.conf");
    expect(unit).toContain("install -d -o app-blog -g caddy -m 0710 /run/layer-php/blog");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("MemoryMax=512M");
    expect(() => renderPhpUnit("blog", settings, "/bin/sh", "/run/layer-php", "caddy")).toThrow();
  });

  it("serves files, blocks what it's told and dotfiles, and is marked live=php", () => {
    const site = renderPhpSite({ slug: "blog", domains: ["blog.example.com"], docroot: "/srv/apps/blog/data/wordpress", socket: "/run/layer-php/blog/php.sock", block: ["/wp-config.php", "/wp-content/uploads/*.php"], uploadMb: 64 });
    expect(site).toContain("php_fastcgi unix//run/layer-php/blog/php.sock");
    expect(site).toContain("@blocked path /wp-config.php /wp-content/uploads/*.php");
    expect(site).toContain("not path /.well-known/*");
    expect(parseLiveMarker(site)).toEqual({ slug: "blog", color: "php", port: null });
  });

  it("refuses paths and settings that could escape", () => {
    expect(() => assertPhpSettings({ root: "../etc" })).toThrow();
    expect(() => assertPhpSettings({ root: "site", private: ["/etc/passwd"] })).toThrow();
    expect(() => assertBlocks(["/ok", "evil { }"])).toThrow();
    expect(() => assertBlocks(["/a\nreverse_proxy x"])).toThrow();
  });
});
