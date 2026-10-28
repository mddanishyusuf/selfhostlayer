import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The agent client and validators are TypeScript source in the monorepo.
  transpilePackages: ["@layer/protocol"],
  // Local `next dev` state (DB, key, setup token) must never ship in a release.
  outputFileTracingExcludes: { "*": [".dev/**", "scripts/**", "**/*.test.ts"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
