import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

const base: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The agent client and validators are TypeScript source in the monorepo.
  transpilePackages: ["@layer/protocol"],
  // Local `next dev` state (DB, key, setup token) must never ship in a release.
  outputFileTracingExcludes: { "*": [".dev/**", "scripts/**", "**/*.test.ts"] },
  // Email's contact import posts the CSV (up to 50 MB) to a server action; the default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "52mb" } },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

// `next dev` gets its own folder: release builds (`next build`) rewrite .next,
// and a dev server sharing it ends up with a stale cache and makes the browser
// reload in a loop ("HMR hash mismatch").
// LAYER_DEV_DIST lets a second dev server (scripts/preview.ts) run next to it.
export default function config(phase: string): NextConfig {
  return { ...base, distDir: phase === PHASE_DEVELOPMENT_SERVER ? (process.env.LAYER_DEV_DIST ?? ".next-dev") : ".next" };
}
