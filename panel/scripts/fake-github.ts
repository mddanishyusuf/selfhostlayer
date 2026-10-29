// A fake GitHub for testing the GitHub App flow end to end without a real
// account: the manifest form, the manifest conversion, the installation
// redirect, JWT-authenticated installation lookups, installation tokens and
// the repo list. Point the panel at it with
//   LAYER_GITHUB_WEB=http://localhost:3999 LAYER_GITHUB_API=http://localhost:3999
//   node panel/scripts/fake-github.ts [port]
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.argv[2] ?? 3999);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
export const FAKE = { code: "fakecode123", appId: 1001, slug: "self-host-layer-test", clientId: "Iv23liFAKE", webhookSecret: "whsec_fake_test_secret", installationId: 4242, token: "ghs_fakeinstallationtoken0001" };

let manifest: { name: string; redirect_url: string; setup_url: string } | null = null;

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const redirect = (res: ServerResponse, location: string) => {
  res.writeHead(302, { Location: location });
  res.end();
};

/** Checks an app JWT the way GitHub does: RS256 with the app's key, iss = client id, not expired. */
function validJwt(req: IncomingMessage): boolean {
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;
  if (!createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const now = Math.floor(Date.now() / 1000);
  return claims.iss === FAKE.clientId && claims.exp > now && claims.exp - claims.iat <= 600;
}

const installation = { id: FAKE.installationId, account: { login: "mddanishyusuf", type: "User" }, repository_selection: "selected", suspended_at: null };
const repos = [
  { id: 1, name: "selfhostlayer-examples", full_name: "mddanishyusuf/selfhostlayer-examples", owner: { login: "mddanishyusuf" }, private: false, default_branch: "main", pushed_at: new Date(Date.now() - 3600_000).toISOString(), html_url: "https://github.com/mddanishyusuf/selfhostlayer-examples" },
  { id: 2, name: "piqo", full_name: "mddanishyusuf/piqo", owner: { login: "mddanishyusuf" }, private: true, default_branch: "main", pushed_at: new Date(Date.now() - 86400_000 * 3).toISOString(), html_url: "https://github.com/mddanishyusuf/piqo" },
  // FAKE_REPOS=<n> adds n more, for paging through a long list.
  ...Array.from({ length: Number(process.env.FAKE_REPOS ?? 0) }, (_, i) => ({
    id: 100 + i,
    name: `project-${i + 1}`,
    full_name: `mddanishyusuf/project-${i + 1}`,
    owner: { login: "mddanishyusuf" },
    private: i % 3 === 0,
    default_branch: "main",
    pushed_at: new Date(Date.now() - 86400_000 * (i + 4)).toISOString(),
    html_url: `https://github.com/mddanishyusuf/project-${i + 1}`,
  })),
];

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const path = url.pathname;

  // The browser posts the manifest form; GitHub would show a confirm page, we go straight back.
  if (req.method === "POST" && /^(\/organizations\/[^/]+)?\/settings\/apps\/new$/.test(path)) {
    const form = new URLSearchParams(await body(req));
    manifest = JSON.parse(form.get("manifest") ?? "null");
    if (!manifest?.redirect_url) return json(res, 400, { message: "no manifest" });
    return redirect(res, `${manifest.redirect_url}?code=${FAKE.code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`);
  }
  if (req.method === "POST" && path === `/app-manifests/${FAKE.code}/conversions`) {
    if (!manifest) return json(res, 404, { message: "Not Found" });
    return json(res, 201, {
      id: FAKE.appId,
      slug: FAKE.slug,
      name: manifest.name,
      client_id: FAKE.clientId,
      client_secret: "fake_client_secret",
      webhook_secret: FAKE.webhookSecret,
      pem,
      html_url: `http://localhost:${port}/apps/${FAKE.slug}`,
      owner: { login: "mddanishyusuf", type: "User" },
    });
  }
  if (req.method === "GET" && path === `/apps/${FAKE.slug}/installations/new`) {
    if (!manifest) return json(res, 404, { message: "Not Found" });
    return redirect(res, `${manifest.setup_url}?installation_id=${FAKE.installationId}&setup_action=install`);
  }
  const inst = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
  if (inst) {
    if (!validJwt(req)) return json(res, 401, { message: "A JSON web token could not be decoded" });
    if (Number(inst[1]) !== FAKE.installationId) return json(res, 404, { message: "Not Found" });
    if (inst[2] && req.method === "POST") return json(res, 201, { token: FAKE.token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    return json(res, 200, installation);
  }
  if (req.method === "GET" && path === "/installation/repositories") {
    if (req.headers.authorization !== `Bearer ${FAKE.token}`) return json(res, 401, { message: "Bad credentials" });
    // Paged like GitHub: per_page (at most 100) and page.
    const perPage = Math.min(100, Number(url.searchParams.get("per_page") ?? 30));
    const page = Number(url.searchParams.get("page") ?? 1);
    return json(res, 200, { total_count: repos.length, repositories: repos.slice((page - 1) * perPage, page * perPage) });
  }
  json(res, 404, { message: `fake-github: no route for ${req.method} ${path}` });
}).listen(port, () => console.log(`fake GitHub on http://localhost:${port}`));
