// Runs once when the panel server starts: start the alerts monitor.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // In `next dev` on a Mac there's no agent to watch, unless asked for.
  if (process.env.NODE_ENV !== "production" && process.env.LAYER_MONITOR !== "1") return;
  const { startMonitor } = await import("./lib/alerts/monitor");
  startMonitor();
}
