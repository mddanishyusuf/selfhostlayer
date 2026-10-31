// /script.js, what a site includes:
//   <script defer src="https://<analytics domain>/script.js" data-site="example.com"></script>
// A pageview on load and on each route change (pushState, popstate), a ping
// when the page is hidden (for time on page), and window.shl.track(name, props)
// for custom events. No cookies, no storage. Sent with sendBeacon as text, so
// browsers make no preflight request. Nothing is sent from localhost, files,
// automated browsers (navigator.webdriver) or pages being prerendered.

export const SCRIPT = `(function () {
  var d = document, w = window, me = d.currentScript, site = me && me.getAttribute("data-site");
  var api = me && me.src.replace(/\\/script\\.js(\\?.*)?$/, "/api/event");
  w.shl = { track: function () {} };
  if (!site || !api || navigator.webdriver || location.protocol === "file:" || /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)) return;
  var last;
  function send(n, p) {
    var body = JSON.stringify({ n: n, s: site, u: location.href, r: d.referrer || null, w: w.innerWidth, p: p });
    if (navigator.sendBeacon && navigator.sendBeacon(api, body)) return;
    fetch(api, { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(function () {});
  }
  function page() {
    if (last === location.pathname) return;
    last = location.pathname;
    send("pageview");
  }
  var push = history.pushState;
  history.pushState = function () {
    push.apply(this, arguments);
    page();
  };
  w.addEventListener("popstate", page);
  d.addEventListener("visibilitychange", function () {
    if (d.visibilityState === "hidden") send("ping");
  });
  w.shl.track = function (name, props) {
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
