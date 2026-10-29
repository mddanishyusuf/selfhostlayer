import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { Albert_Sans } from "next/font/google";
import { cookies } from "next/headers";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import "./globals.css";

// Fetched at build time and served from the panel itself: no requests to Google at runtime.
const albertSans = Albert_Sans({ subsets: ["latin"], variable: "--font-albert-sans", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Self Host Layer", template: "%s · Self Host Layer" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f5" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1a19" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set on the server from the cookie, so the first paint is already in the right theme.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} className={`${albertSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
