// /script.js, what a site includes:
//   <script defer src="https://<analytics domain>/script.js" data-site="example.com"></script>
// A pageview on load and on each route change (pushState, popstate), a ping
// when the page is hidden (for time on page), clicks on links to other sites
// (the event "Outbound link"), and window.shl.track(name, props) for custom
// events. No cookies, no storage. Events go with sendBeacon as text, so
// browsers make no preflight request; pageviews go with fetch, whose answer
// names the visit: window.shl.visit, or `await window.shl.ready`, for the
// site to pass into its checkout. Links to Stripe Payment Links and Dodo
// Payments' links get it added on the way out. Nothing is sent from
// localhost, files, automated browsers (navigator.webdriver) or pages being
// prerendered.

export const SCRIPT = `(function () {
  var d = document, w = window, me = d.currentScript, site = me && me.getAttribute("data-site");
  var api = me && me.src.replace(/\\/script\\.js(\\?.*)?$/, "/api/event");
  var done, shl = (w.shl = { visit: null, track: function () {}, ready: new Promise(function (r) { done = r; }) });
  if (!site || !api || navigator.webdriver || location.protocol === "file:" || /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) return done(null);
  var last;
  function send(n, p) {
    var body = JSON.stringify({ n: n, s: site, u: location.href, r: d.referrer || null, w: w.innerWidth, p: p });
    if (n !== "pageview" && navigator.sendBeacon && navigator.sendBeacon(api, body)) return;
    fetch(api, { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.visit) (shl.visit = j.visit), (shl.ready = Promise.resolve(j.visit));
        done(shl.visit);
      }, function () { done(shl.visit); });
  }
  function page() {
    if (last === location.pathname) return;
    last = location.pathname;
    send("pageview");
  }
  function click(e) {
    var a = e.target.closest && e.target.closest("a[href]"), v = shl.visit, q;
    if (!a || !/^https?:$/.test(a.protocol) || a.host === location.host) return;
    q = a.hostname === "buy.stripe.com" ? "client_reference_id" : a.hostname === "checkout.dodopayments.com" ? "metadata_shl_visit" : "";
    if (v && q && a.search.indexOf(q + "=") < 0) a.search += (a.search ? "&" : "") + q + "=" + v;
    send("Outbound link", { url: a.origin + a.pathname });
  }
  var push = history.pushState;
  history.pushState = function () {
    push.apply(this, arguments);
    page();
  };
  w.addEventListener("popstate", page);
  d.addEventListener("click", click, true);
  d.addEventListener("auxclick", click, true);
  d.addEventListener("visibilitychange", function () {
    if (d.visibilityState === "hidden") send("ping");
  });
  shl.track = function (name, props) {
    send(String(name), props);
  };
  if (d.visibilityState === "prerender") {
    d.addEventListener("visibilitychange", function shown() {
      if (d.visibilityState !== "visible") return;
      d.removeEventListener("visibilitychange", shown);
      page();
    });
  } else page();
})();
`;
