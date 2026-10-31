// node cron.js geo: Forms' cron job, run by Self Host Layer as the app's user
// in its release folder (layer.yaml says when): DB-IP's newest country list.
import { updateGeo } from "../../lib/geo-update.ts";

if (process.argv[2] === "geo") {
  const r = await updateGeo(process.env.DATA_DIR ?? "data");
  console.log(`Countries now come from ${r.source} (${Math.round(r.bytes / 1024)} KB).`);
} else {
  console.error("usage: node cron.js geo");
  process.exit(2);
}
