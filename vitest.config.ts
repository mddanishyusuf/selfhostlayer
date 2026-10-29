import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Build output (panel/.next*, dist/release) contains copies of the panel's
    // sources; only test the real ones.
    exclude: ["**/node_modules/**", "dist/**", "**/.next/**", "**/.next-dev/**", "**/.next-preview/**"],
  },
});
