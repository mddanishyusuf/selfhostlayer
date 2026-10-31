import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { cookies } from "next/headers";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import "./globals.css";

// Marlin Soft SQ, AgentOS's UI font: served by the panel itself from app/fonts,
// so no font requests to anyone at runtime. Code uses the system's monospace.
const marlin = localFont({
  src: [
    { path: "./fonts/MarlinSoftSQ-Regular.woff2", weight: "400" },
    { path: "./fonts/MarlinSoftSQ-Medium.woff2", weight: "500" },
    { path: "./fonts/MarlinSoftSQ-Bold.woff2", weight: "700" },
    { path: "./fonts/MarlinSoftSQ-ExtraBlack.woff2", weight: "900" },
  ],
  variable: "--font-marlin",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Self Host Layer", template: "%s · Self Host Layer" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0e0e" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set on the server from the cookie, so the first paint is already in the right theme.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} className={marlin.variable}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
