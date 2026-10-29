// The panel's color theme: dark (the default), light, or follow the system.
// Stored in a cookie so the server renders the right one on the first paint.
export type Theme = "dark" | "light" | "system";

export const THEME_COOKIE = "layer-theme";

export function parseTheme(value: string | undefined): Theme {
  return value === "light" || value === "system" ? value : "dark";
}
