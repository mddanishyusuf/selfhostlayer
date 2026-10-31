import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import "./globals.css";

// Inter is fetched at build time and Geist Mono ships in the geist package:
// both are served by the panel itself, so no font requests to anyone at runtime.
// Inter with its optical sizes, so titles get the tighter display cut on their own.
const inter = Inter({ subsets: ["latin"], axes: ["opsz"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Self Host Layer", template: "%s · Self Host Layer" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set on the server from the cookie, so the first paint is already in the right theme.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} className={`${inter.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
