import { spawn } from "node:child_process";
import { assertColor, assertInt, assertSlug, COLORS, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { BIN, SAFE_ENV } from "../exec.ts";

const MAX_FOLLOW_MS = 60 * 60_000;

/**
 * journalctl for the app's units. Without follow it returns the last lines;
 * with follow it streams new lines as chunks until the client disconnects
 * (or an hour passes).
 */
async function logsTail(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const colors = params.color === undefined ? COLORS : [assertColor(params.color)];
  const lines = assertInt(params.lines ?? 100, "lines", 1, 10_000);
  const follow = params.follow ?? false;
  if (typeof follow !== "boolean") throw new ValidationError("follow", "must be true or false");

  // The app's workers too, unless one color was asked for (each line names its unit).
  const workers = params.color === undefined ? [`--unit=app-${slug}-worker-*.service`] : [];
  const args = ["--no-pager", "--output=short-iso", `--lines=${lines}`, ...colors.map((c) => `--unit=app-${slug}@${c}.service`), ...workers];
  if (!follow) {
    const { stdout } = await ctx.exec(BIN.journalctl, args);
    return { slug, lines: stdout.split("\n").filter((l) => l && l !== "-- No entries --") };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(BIN.journalctl, [...args, "--follow"], { env: SAFE_ENV, stdio: ["ignore", "pipe", "ignore"] });
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(stop, MAX_FOLLOW_MS);
    io.signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => io.emit(chunk));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      io.signal.removeEventListener("abort", stop);
      resolve({ slug, followed: true });
    });
  });
}

export const logsActions: ActionTable = {
  "logs.tail": { mutates: false, run: logsTail },
};
