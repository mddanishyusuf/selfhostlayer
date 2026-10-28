import { existsSync } from "node:fs";
import { assertSlug } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { assertEnvVars, renderEnvFile } from "../templates/env-file.ts";
import { appLayout } from "./app.ts";

/**
 * Replaces the app's whole env (root-only app.env, injected by systemd).
 * Doesn't restart the app: the panel decides when the new env takes effect.
 */
async function envWrite(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const vars = assertEnvVars(params.vars);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  writeFileAtomic(app.appEnv, renderEnvFile(vars), 0o600);
  return { slug, keys: Object.keys(vars) };
}

export const envActions: ActionTable = {
  "env.write": {
    mutates: true,
    run: envWrite,
    // Never write secret values to the audit log.
    redact: (params) => ({
      slug: params.slug,
      keys: typeof params.vars === "object" && params.vars !== null ? Object.keys(params.vars) : [],
    }),
  },
};
