import { connect } from "node:tls";

export type CertStatus =
  | { ok: true; issuer: string; validTo: string; daysLeft: number }
  | { ok: false; reason: "issuing" | "untrusted" | "expired" | "unreachable"; detail: string };

/**
 * Whether visitors get a valid certificate for host: a TLS handshake through
 * Caddy (127.0.0.1:443) with host as SNI, verified against the trust store.
 */
export function checkCertificate(host: string, address = "127.0.0.1", port = 443): Promise<CertStatus> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port, servername: host, rejectUnauthorized: true, timeout: 8000 });
    const done = (status: CertStatus) => {
      socket.destroy();
      resolve(status);
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const validTo = new Date(cert.valid_to).toISOString();
      const issuer = (Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O) ?? cert.issuer?.CN ?? "unknown";
      done({ ok: true, issuer: String(issuer), validTo, daysLeft: Math.floor((Date.parse(validTo) - Date.now()) / 86_400_000) });
    });
    socket.once("timeout", () => done({ ok: false, reason: "unreachable", detail: "no answer on port 443" }));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      if (code === "CERT_HAS_EXPIRED") return done({ ok: false, reason: "expired", detail: err.message });
      // Caddy answers with a TLS alert while it has no certificate for the name yet.
      if (code.startsWith("ERR_SSL_") || code === "ECONNRESET") return done({ ok: false, reason: "issuing", detail: err.message });
      if (code.includes("CERT") || code.includes("SIGNATURE") || code.includes("SELF_SIGNED")) return done({ ok: false, reason: "untrusted", detail: err.message });
      done({ ok: false, reason: "unreachable", detail: err.message });
    });
  });
}
