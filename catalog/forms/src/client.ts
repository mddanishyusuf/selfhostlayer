// The script and styles of a form's page: it renders the form from its schema
// (classic: a page of fields, page breaks for steps; conversational: one
// question at a time, Enter to go on, a progress bar), applies the logic,
// checks answers as they're given, posts the answers as a line of JSON with the
// files' bytes after it, and shows the thank-you screen. It counts a view on load and a start at
// the first answer, and in an embed tells the page around it how tall it is.
// Plain JS from 2017 on: no framework, no build step, nothing fetched.

export const CLIENT_JS = String.raw`(function () {
  "use strict";
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  var S = cfg.schema, F = S.fields, answers = {}, files = {}, errors = {}, started = false, sending = false, done = false;
  var root = document.getElementById("app");
  var conv = S.layout === "conversational";
  var q = new URLSearchParams(location.search);
  F.forEach(function (f) {
    if (f.type === "file" || f.type === "statement" || f.type === "page_break") return;
    var v = q.get(f.type === "hidden" ? f.param : f.id);
    if (v !== null && v !== "") answers[f.id] = f.type === "multi" ? v.split(",") : v;
  });

  function post(path, body) {
    return fetch(cfg.base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : "{}", keepalive: !body });
  }
  // The panel's preview (a signed ?preview=…) counts nothing and keeps nothing.
  if (!cfg.preview) post("/view").catch(function () {});
  function touch() {
    if (started || cfg.preview) return;
    started = true;
    post("/start").catch(function () {});
  }

  function text(a) { return Array.isArray(a) ? a.join(", ") : a === undefined || a === null ? "" : String(a); }
  function has(a) { return !(a === undefined || a === null || a === "" || (Array.isArray(a) && !a.length)); }
  function byId(id) { for (var i = 0; i < F.length; i++) if (F[i].id === id) return F[i]; return null; }
  function visible(f) {
    var c = f.showIf;
    if (!c) return true;
    var t = byId(c.field);
    if (!t || !visible(t)) return false;
    var a = answers[c.field];
    switch (c.op) {
      case "answered": return has(a);
      case "not_answered": return !has(a);
      case "is": return Array.isArray(a) ? a.indexOf(c.value) >= 0 : text(a).toLowerCase() === c.value.toLowerCase();
      case "is_not": return Array.isArray(a) ? a.indexOf(c.value) < 0 : text(a).toLowerCase() !== c.value.toLowerCase();
      case "contains": return text(a).toLowerCase().indexOf(c.value.toLowerCase()) >= 0;
      case "gt": return has(a) && Number(a) > Number(c.value);
      case "lt": return has(a) && Number(a) < Number(c.value);
    }
    return true;
  }
  function asks(f) { return f.type !== "page_break" && f.type !== "hidden"; }
  function check(f) {
    if (f.type === "statement") return "";
    var a = f.type === "file" ? files[f.id] : answers[f.id];
    if (!has(a)) return f.required ? "This is required." : "";
    var s = text(a).trim();
    if (f.type === "email" && !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(s)) return "That isn't an email address.";
    if (f.type === "url" && !/^https?:\/\/\S+$/i.test(s)) return "That isn't a link (https://…).";
    if (f.type === "phone" && !/^[+()\d\s.-]{4,30}$/.test(s)) return "That isn't a phone number.";
    if (f.type === "number") {
      var n = Number(a);
      if (!isFinite(n)) return "That isn't a number.";
      if (f.min !== null && n < f.min) return "At least " + f.min + ".";
      if (f.max !== null && n > f.max) return "At most " + f.max + ".";
    }
    var max = f.maxLength || (f.type === "long_text" ? 10000 : 1000);
    if ((f.type === "short_text" || f.type === "long_text") && s.length > max) return "At most " + max + " characters.";
    return "";
  }

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  /** Which fields show now: when an answer changes it, the page is drawn again. */
  function shownNow() { return F.filter(function (f) { return visible(f); }).map(function (f) { return f.id; }).join(","); }
  function set(f, v, rerender) {
    touch();
    var before = shownNow();
    answers[f.id] = v;
    delete errors[f.id];
    if (rerender) return render();
    if (shownNow() !== before) {
      // Typing in a text field: drawn again with the cursor where it was.
      var el = document.activeElement, id = el && el.id, pos = el && el.selectionStart;
      render();
      var again = id && document.getElementById(id);
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
    }
  }

  function control(f) {
    var a = answers[f.id];
    var id = "f-" + f.id;
    switch (f.type) {
      case "short_text": case "email": case "url": case "phone": case "number": case "date":
        var type = { short_text: "text", email: "email", url: "url", phone: "tel", number: "number", date: "date" }[f.type];
        return h("input", { id: id, class: "input", type: type, value: a === undefined ? "" : a, placeholder: f.placeholder || null, min: f.min, max: f.max, maxlength: f.maxLength, autocomplete: f.type === "email" ? "email" : f.type === "phone" ? "tel" : null, oninput: function (e) { set(f, e.target.value, false); } });
      case "long_text":
        return h("textarea", { id: id, class: "input", rows: 4, placeholder: f.placeholder || null, maxlength: f.maxLength, oninput: function (e) { set(f, e.target.value, false); } }, [a || ""]);
      case "dropdown":
        return h("select", { id: id, class: "input", onchange: function (e) { set(f, e.target.value, true); } }, [h("option", { value: "", text: f.placeholder || "Choose…" })].concat(f.options.map(function (o) { return h("option", { value: o, selected: a === o, text: o }); })));
      case "choice": case "multi": case "yes_no":
        var opts = f.type === "yes_no" ? ["Yes", "No"] : f.options;
        return h("div", { class: "choices", role: f.type === "multi" ? "group" : "radiogroup" }, opts.map(function (o, i) {
          var value = f.type === "yes_no" ? o.toLowerCase() : o;
          var on = f.type === "multi" ? (a || []).indexOf(value) >= 0 : a === value;
          return h("button", { type: "button", class: "choice" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", onclick: function () {
            if (f.type === "multi") { var list = (answers[f.id] || []).slice(); var at = list.indexOf(value); if (at >= 0) list.splice(at, 1); else list.push(value); set(f, list, true); }
            else { set(f, value, true); if (conv && !check(f)) setTimeout(next, 250); }
          } }, [h("span", { class: "key", text: String.fromCharCode(65 + i) }), h("span", { text: o })]);
        }));
      case "rating":
        var stars = [];
        for (var r = 1; r <= (f.max || 5); r++) (function (n) {
          stars.push(h("button", { type: "button", class: "star" + (Number(a) >= n ? " on" : ""), "aria-label": n + " of " + (f.max || 5), onclick: function () { set(f, n, true); if (conv) setTimeout(next, 250); } }, ["★"]));
        })(r);
        return h("div", { class: "stars" }, stars);
      case "scale":
        var lo = f.min === null ? 0 : f.min, hi = f.max === null ? 10 : f.max, cells = [];
        for (var s = lo; s <= hi; s++) (function (n) {
          cells.push(h("button", { type: "button", class: "cell" + (a !== undefined && Number(a) === n ? " on" : ""), onclick: function () { set(f, n, true); if (conv) setTimeout(next, 250); } }, [String(n)]));
        })(s);
        return h("div", { class: "scale" }, cells);
      case "file":
        var file = files[f.id];
        return h("div", { class: "file" }, [
          h("input", { id: id, type: "file", accept: f.accept || null, onchange: function (e) {
            var picked = e.target.files && e.target.files[0];
            if (!picked) return;
            touch();
            if (picked.size > 10 * 1024 * 1024) { errors[f.id] = "Files are at most 10 MB."; return render(); }
            // The file itself: it's sent as it is, after the answers.
            files[f.id] = picked; delete errors[f.id]; render();
          } }),
          file ? h("span", { class: "muted", text: file.name }) : null,
        ]);
    }
    return null;
  }

  function question(f, n) {
    if (f.type === "statement") return h("div", { class: "q statement" }, [f.label ? h("h2", { text: f.label }) : null, f.help ? h("p", { class: "muted pre", text: f.help }) : null]);
    return h("div", { class: "q" + (errors[f.id] ? " bad" : ""), "data-field": f.id }, [
      h("label", { class: "label", for: "f-" + f.id }, [conv && n ? h("span", { class: "n", text: n + " →" }) : null, f.label || "Untitled", f.required ? h("span", { class: "req", text: " *" }) : null]),
      f.help ? h("p", { class: "muted pre", text: f.help }) : null,
      control(f),
      errors[f.id] ? h("p", { class: "error", role: "alert", text: errors[f.id] }) : null,
    ]);
  }

  // Classic: pages between page breaks. Conversational: one question a step.
  function pages() {
    var out = [[]];
    F.forEach(function (f) { if (f.type === "page_break") out.push([]); else out[out.length - 1].push(f); });
    return out.filter(function (p) { return p.length; });
  }
  function steps() { return F.filter(function (f) { return asks(f) && visible(f); }); }
  var at = 0;

  function current() {
    if (conv) { var st = steps(); return st[Math.min(at, st.length - 1)] ? [st[Math.min(at, st.length - 1)]] : []; }
    var p = pages()[at] || [];
    return p.filter(function (f) { return asks(f) && visible(f); });
  }
  function last() { return conv ? at >= steps().length - 1 : at >= pages().length - 1; }
  function valid(list) {
    var ok = true;
    list.forEach(function (f) { var e = check(f); if (e) { errors[f.id] = e; ok = false; } else delete errors[f.id]; });
    return ok;
  }
  function next() {
    if (sending || done) return;
    if (!valid(current())) return render(true);
    if (last()) return submit();
    at++;
    render(true);
  }
  function back() { if (at > 0) { at--; render(true); } }

  function submit() {
    var all = F.filter(function (f) { return visible(f) && f.type !== "page_break" && f.type !== "statement" && f.type !== "hidden"; });
    if (!valid(all)) {
      // Back to the first step with something wrong.
      var first = all.filter(function (f) { return errors[f.id]; })[0];
      if (first) { var list = conv ? steps() : pages(); for (var i = 0; i < list.length; i++) if ((conv ? [list[i]] : list[i]).indexOf(first) >= 0) { at = i; break; } }
      return render(true);
    }
    if (cfg.preview) { done = true; return render(true); }
    sending = true;
    render();
    var hp = document.getElementById("hp");
    var shown = {};
    F.forEach(function (f) { if (f.type !== "file" && visible(f) && has(answers[f.id])) shown[f.id] = answers[f.id]; });
    // A line of JSON (the answers, and each file's name, type and size), then the files' bytes.
    var sent = F.filter(function (f) { return f.type === "file" && visible(f) && files[f.id]; });
    var head = { t: cfg.token, hp: hp ? hp.value : "", answers: shown, files: sent.map(function (f) { var x = files[f.id]; return { field: f.id, name: x.name, type: x.type || "application/octet-stream", size: x.size }; }) };
    var body = new Blob([JSON.stringify(head) + "\n"].concat(sent.map(function (f) { return files[f.id]; })));
    fetch(cfg.base + "/submit", { method: "POST", headers: { "Content-Type": "application/x-forms-response" }, body: body }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        sending = false;
        if (!r.ok) {
          if (j.field && byId(j.field)) { errors[j.field] = (j.error || "Check this answer.").replace(/^[^:]*: /, ""); }
          else errors._form = j.error || "It didn't go through: try again.";
          return render(true);
        }
        done = true;
        if (S.thanks.redirect) { try { (window.top || window).location.href = S.thanks.redirect; } catch (e) { location.href = S.thanks.redirect; } return; }
        render(true);
      });
    }, function () { sending = false; errors._form = "It didn't go through: check your connection and try again."; render(true); });
  }

  function render(focus) {
    root.textContent = "";
    var card = h("main", { class: "card" + (conv ? " conv" : "") });
    if (done) {
      card.appendChild(h("div", { class: "thanks" }, [h("div", { class: "tick", text: "✓" }), h("h1", { text: S.thanks.title || "Thanks!" }), S.thanks.message && !(cfg.preview && S.thanks.redirect) ? h("p", { class: "muted pre", text: S.thanks.message }) : null, cfg.preview ? h("p", { class: "muted", text: "A preview: nothing was saved." + (S.thanks.redirect ? " The form goes to " + S.thanks.redirect + " now." : "") }) : null]));
      root.appendChild(card);
      return;
    }
    if (conv) {
      var total = steps().length || 1;
      card.appendChild(h("div", { class: "progress" }, [h("div", { class: "bar", style: "width:" + Math.round((Math.min(at, total) / total) * 100) + "%" })]));
    }
    if (at === 0) {
      if (S.theme.logo) card.appendChild(h("img", { class: "logo", src: S.theme.logo, alt: "" }));
      card.appendChild(h("h1", { text: cfg.title }));
      if (S.description) card.appendChild(h("p", { class: "muted pre intro", text: S.description }));
    }
    var list = current();
    var n = conv ? at + 1 : 0;
    list.forEach(function (f) { card.appendChild(question(f, n)); });
    if (errors._form) card.appendChild(h("p", { class: "error", role: "alert", text: errors._form }));
    var nav = h("div", { class: "nav" }, [
      at > 0 ? h("button", { type: "button", class: "ghost", onclick: back, text: "Back" }) : h("span"),
      h("button", { type: "button", class: "primary", disabled: sending, onclick: next, text: sending ? "Sending…" : last() ? S.button || "Submit" : "Next" }),
    ]);
    card.appendChild(nav);
    if (conv && !last()) card.appendChild(h("p", { class: "hint muted", text: "Press Enter ↵" }));
    root.appendChild(card);
    if (focus) {
      var first = card.querySelector(".bad input, .bad textarea, .bad select, .bad button") || card.querySelector("input:not([type=file]), textarea, select");
      if (first && first.focus) first.focus();
    }
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.isComposing) return;
    var t = e.target;
    if (t && t.tagName === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return;
    if (t && t.tagName === "BUTTON") return;
    e.preventDefault();
    next();
  });
  if (conv) document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"))) return;
    var i = e.key.toUpperCase().charCodeAt(0) - 65;
    var btns = root.querySelectorAll(".choices .choice");
    if (e.key.length === 1 && i >= 0 && i < btns.length) btns[i].click();
  });

  if (window.parent !== window && "ResizeObserver" in window) {
    new ResizeObserver(function () { window.parent.postMessage({ type: "shl-form", slug: cfg.slug, height: document.documentElement.scrollHeight }, "*"); }).observe(document.body);
  }
  render();
})();`;

export const CLIENT_CSS = `
:root{--accent:#4f46e5;--bg:#f7f7f8;--card:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--field:#fff;--on:#eef2ff}
:root[data-mode=dark]{--bg:#0f0f10;--card:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--line:#2e2e33;--field:#0f0f10;--on:#1e1b4b}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
body.embed{background:transparent}
#app{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px}body.embed #app{min-height:0;padding:0}
.card{width:100%;max-width:640px;background:var(--card);border:1px solid var(--line);padding:32px;display:grid;gap:22px}
body.embed .card{border:0;padding:8px 4px}
.card.conv{max-width:680px;min-height:60vh;align-content:center}
h1{margin:0;font-size:26px;line-height:1.25}h2{margin:0;font-size:20px}
.muted{color:var(--muted);margin:0}.pre{white-space:pre-wrap}.intro{margin-top:-14px}
.logo{max-height:40px;max-width:180px;object-fit:contain}
.q{display:grid;gap:8px}.label{font-weight:600}.n{color:var(--accent);margin-right:8px;font-weight:500}.req{color:var(--accent)}
.input{width:100%;font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);padding:10px 12px;border-radius:6px;outline:none}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
textarea.input{resize:vertical;min-height:96px}
.conv .input{font-size:20px;border-width:0 0 2px;border-radius:0;background:transparent;padding:8px 0}
.choices{display:grid;gap:8px}
.choice{display:flex;align-items:center;gap:10px;text-align:left;font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);padding:10px 12px;border-radius:6px;cursor:pointer}
.choice:hover{border-color:var(--accent)}.choice.on{border-color:var(--accent);background:var(--on)}
.key{display:inline-grid;place-items:center;min-width:22px;height:22px;font-size:12px;border:1px solid var(--line);border-radius:4px;color:var(--muted)}
.choice.on .key{background:var(--accent);border-color:var(--accent);color:#fff}
.stars{display:flex;gap:6px}.star{font-size:30px;line-height:1;background:none;border:0;cursor:pointer;color:var(--line);padding:0}.star.on{color:var(--accent)}
.scale{display:grid;grid-template-columns:repeat(auto-fit,minmax(36px,1fr));gap:6px}
.cell{font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);padding:8px 0;border-radius:6px;cursor:pointer}.cell.on{background:var(--accent);border-color:var(--accent);color:#fff}
.file{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.nav{display:flex;justify-content:space-between;align-items:center;gap:12px}
button.primary{font-family:inherit;font-weight:600;font-size:16px;line-height:1;color:#fff;background:var(--accent);border:0;padding:12px 20px;border-radius:6px;cursor:pointer}
button.primary[disabled]{opacity:.6;cursor:default}
button.ghost{font:inherit;color:var(--muted);background:none;border:0;cursor:pointer;padding:8px 4px}
.error{color:#dc2626;margin:0;font-size:14px}.q.bad .input{border-color:#dc2626}
.hint{font-size:13px;text-align:right;margin-top:-12px}
.progress{height:4px;background:var(--line);border-radius:2px;overflow:hidden}.bar{height:100%;background:var(--accent);transition:width .25s}
.thanks{display:grid;justify-items:center;text-align:center;gap:10px;padding:24px 0}
.tick{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:var(--accent);color:#fff;font-size:26px}
.closed{text-align:center}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
.brand{font-size:12px;color:var(--muted);text-align:center;margin-top:-6px}.brand a{color:inherit}
`;
