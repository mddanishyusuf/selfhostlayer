import { existsSync, readFileSync } from "node:fs";
import { config } from "./config";
import { safeEqual, sha256 } from "./crypto";

/**
 * The one-time setup token the installer prints. The installer stores only
 * its hash: "sha256:<hex> <expires-unix-seconds>" in /etc/layer/setup-token
 * (root:layer 640), so the panel can check it but never learn it.
 */
export function checkSetupToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): "ok" | "invalid" | "expired" | "missing" {
  if (!existsSync(config.setupTokenFile)) return "missing";
  const [hash, expires] = readFileSync(config.setupTokenFile, "utf8").trim().split(/\s+/);
  if (!hash?.startsWith("sha256:") || !expires) return "missing";
  if (!safeEqual(`sha256:${sha256(token.trim())}`, hash)) return "invalid";
  return Number(expires) < nowSeconds ? "expired" : "ok";
}
