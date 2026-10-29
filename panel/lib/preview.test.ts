import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// config reads LAYER_DB when it loads: point it at a temp folder first.
process.env.LAYER_DB = join(mkdtempSync(join(tmpdir(), "layer-preview-")), "panel.db");
const { isPublicAddress, parsePreviewMeta, previewImage, removePreview, sitePreview } = await import("./preview");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("parsePreviewMeta", () => {
  it("reads og tags in any attribute order, decodes entities and resolves the image", () => {
    const html = `<head><title>Fallback</title>
      <meta content="Reduce PNG size &amp; keep quality" property="og:title">
      <meta name="description" content='Free &#x26; private'>
      <meta property="og:image" content="/og.png?v=1&amp;w=1200" data-next-head="">
    </head>`;
    expect(parsePreviewMeta(html, "https://example.com/app/")).toEqual({
      title: "Reduce PNG size & keep quality",
      description: "Free & private",
      image: "https://example.com/og.png?v=1&w=1200",
    });
  });

  it("falls back to twitter tags and <title>, and drops non-http images", () => {
    expect(parsePreviewMeta(`<title>My  site</title><meta name="twitter:image" content="https://cdn.x/i.jpg">`, "https://a.b/")).toEqual({ title: "My site", description: null, image: "https://cdn.x/i.jpg" });
    expect(parsePreviewMeta(`<meta property="og:image" content="javascript:alert(1)">`, "https://a.b/").image).toBeNull();
  });
});

describe("isPublicAddress", () => {
  it("refuses loopback, private, link-local, CGNAT and mapped private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["37.27.25.45", "1.1.1.1", "2a01:4f9:c012::1", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("sitePreview", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const page = (head: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<html><head>${head}</head></html>`);
      if (req.url === "/") return page(`<title>Home</title><meta property="og:image" content="/og.png">`);
      if (req.url === "/og.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
      if (req.url === "/svg") return page(`<meta property="og:image" content="/og.svg">`);
      if (req.url === "/og.svg") return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end("<svg onload='alert(1)'/>");
      if (req.url === "/private") return page(`<title>P</title><meta property="og:image" content="http://10.0.0.1/x.png">`);
      if (req.url === "/metadata") return res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("saves the site's image once per deployment", async () => {
    const p = await sitePreview("home", 1, `${base}/`, ["127.0.0.1"]);
    expect(p).toMatchObject({ deploymentId: 1, title: "Home", image: "home.png" });
    expect(previewImage("home")).toEqual({ body: PNG, type: "image/png" });
    expect((await sitePreview("home", 1, `${base}/`, ["127.0.0.1"])).fetchedAt).toBe(p.fetchedAt);
    removePreview("home");
    expect(previewImage("home")).toBeNull();
  });

  it("never keeps an SVG", async () => {
    expect(await sitePreview("svg", 1, `${base}/svg`, ["127.0.0.1"])).toMatchObject({ image: null });
    expect(previewImage("svg")).toBeNull();
  });

  it("doesn't fetch private addresses the page points to, or redirects to them", async () => {
    expect(await sitePreview("private", 1, `${base}/private`, ["127.0.0.1"])).toMatchObject({ title: "P", image: null });
    expect((await sitePreview("meta", 1, `${base}/metadata`, ["127.0.0.1"])).error).toMatch(/isn't a public address/);
  });
});
