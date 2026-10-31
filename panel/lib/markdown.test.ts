import { describe, expect, it } from "vitest";
import { markdownEmail, markdownToHtml } from "./markdown";

describe("Markdown for emails", () => {
  it("makes headings, paragraphs, lists, quotes, links, images, buttons and lines, styled inline", () => {
    const html = markdownToHtml(["# Hello {{first_name}}", "", "Some **bold** and *italic* and `code`.", "A second line.", "", "- one", "- [two](https://piqo.app/two)", "", "1. first", "", "> quoted", "", "![Logo](https://piqo.app/logo.png)", "", "[[Get started](https://piqo.app/start)]", "", "---"].join("\n"));
    expect(html).toContain(">Hello {{first_name}}</h1>");
    expect(html).toContain("Some <strong>bold</strong> and <em>italic</em> and <code");
    expect(html).toContain("</code>.<br>A second line.</p>");
    expect(html).toMatch(/<ul [^>]+><li [^>]+>one<\/li><li [^>]+><a href="https:\/\/piqo.app\/two"/);
    expect(html).toMatch(/<ol /);
    expect(html).toContain("<blockquote");
    expect(html).toContain('<img src="https://piqo.app/logo.png" alt="Logo"');
    expect(html).toMatch(/<a href="https:\/\/piqo.app\/start" style="display:inline-block[^"]+">Get started<\/a>/);
    expect(html).toContain("<hr");
  });

  it("shows HTML as text, and drops links that aren't web or mail links", () => {
    const html = markdownToHtml('<script>alert(1)</script> [x](javascript:alert(1)) [y]({{unsubscribe_url}})');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<a href="#"');
    expect(html).toContain('<a href="{{unsubscribe_url}}"');
  });

  it("wraps it in an email with the brand, its address and the unsubscribe link", () => {
    const doc = markdownEmail("Hi", { brand: "Piqo", address: "1 Main St\nBerlin" });
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain("Piqo<br>1 Main St<br>Berlin<br><a href=\"{{unsubscribe_url}}\"");
  });
});
