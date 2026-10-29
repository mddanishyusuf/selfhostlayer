// GitHub App integration. Each server creates its own GitHub App through
// GitHub's manifest flow, so the app (and its private key) belongs to the
// user: no central service holds keys or relays webhooks.
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** Overridable so tests and local dev can point at a fake GitHub. */
export const GITHUB_WEB = process.env.LAYER_GITHUB_WEB ?? "https://github.com";
export const GITHUB_API = process.env.LAYER_GITHUB_API ?? "https://api.github.com";

export interface GithubAppCredentials {
  appId: number;
  clientId: string;
  /** PEM, decrypted. */
  privateKey: string;
}

export class GithubError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubError";
    this.status = status;
  }
}

/**
 * The manifest the browser posts to GitHub. Permissions are the minimum for
 * deploys: read code, plus commit statuses for "deployed" checks later.
 */
export function buildManifest(base: string, name: string) {
  return {
    name,
    url: base,
    hook_attributes: { url: `${base}/api/github/webhook`, active: true },
    redirect_url: `${base}/api/github/manifest`,
    setup_url: `${base}/api/github/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", statuses: "write" },
    default_events: ["push"],
  };
}

/** Where the browser posts the manifest: the user's account, or an organization. */
export function manifestFormAction(state: string, org?: string | null): string {
  const path = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : "/settings/apps/new";
  return `${GITHUB_WEB}${path}?state=${encodeURIComponent(state)}`;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** A short-lived JWT that authenticates as the app itself (RS256, 9 minutes). */
export function appJwt(app: GithubAppCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat 60s in the past absorbs clock drift; GitHub allows at most 10 minutes.
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: app.clientId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(app.privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** Checks X-Hub-Signature-256 over the raw request body. */
export function verifyWebhookSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Fetch = typeof fetch;

async function github<T>(path: string, init: RequestInit & { token: string }, fetchImpl: Fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-host-layer",
      Authorization: `Bearer ${init.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubError(res.status, `GitHub ${init.method ?? "GET"} ${path}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
  html_url: string;
  owner: { login: string; type: string };
}

/** Trades the one-time code from the manifest redirect for the app's credentials. No auth needed. */
export async function convertManifest(code: string, fetchImpl: Fetch = fetch): Promise<ManifestConversion> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new GithubError(400, "bad manifest code");
  const res = await fetchImpl(`${GITHUB_API}/app-manifests/${code}/conversions`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "self-host-layer" },
  });
  if (!res.ok) throw new GithubError(res.status, `GitHub refused the app manifest code (HTTP ${res.status})`);
  return (await res.json()) as ManifestConversion;
}

export interface Installation {
  id: number;
  account: { login: string; type: string };
  repository_selection: "all" | "selected";
  suspended_at: string | null;
}

export const getInstallation = (app: GithubAppCredentials, id: number, fetchImpl?: Fetch) =>
  github<Installation>(`/app/installations/${id}`, { token: appJwt(app) }, fetchImpl);

/** Points the app's webhook at the panel's new address: GitHub doesn't follow redirects for deliveries. */
export const setWebhookUrl = (app: GithubAppCredentials, url: string, fetchImpl?: Fetch) =>
  github<unknown>("/app/hook/config", { method: "PATCH", token: appJwt(app), body: JSON.stringify({ url }) }, fetchImpl);

export interface InstallationToken {
  token: string;
  expires_at: string;
}

/**
 * A token for one installation, valid for an hour. Pass repositories (and
 * permissions) to narrow it: a build fetch only gets read access to one repo.
 */
export const installationToken = (
  app: GithubAppCredentials,
  installationId: number,
  scope: { repositories?: string[]; permissions?: Record<string, string> } = {},
  fetchImpl?: Fetch,
) =>
  github<InstallationToken>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", token: appJwt(app), body: JSON.stringify(scope) },
    fetchImpl,
  );

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  html_url: string;
}

/** Every repo an installation can see (paged by 100). */
export async function listInstallationRepos(app: GithubAppCredentials, installationId: number, fetchImpl?: Fetch): Promise<Repo[]> {
  const { token } = await installationToken(app, installationId, { permissions: { metadata: "read" } }, fetchImpl);
  const repos: Repo[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await github<{ total_count: number; repositories: Repo[] }>(
      `/installation/repositories?per_page=100&page=${page}`,
      { token },
      fetchImpl,
    );
    repos.push(...res.repositories);
    if (repos.length >= res.total_count || res.repositories.length === 0) break;
  }
  return repos;
}
