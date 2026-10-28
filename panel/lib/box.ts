// Facts about this server, written by the installer to /etc/layer/config.json
// (root:layer 640). In `next dev` on a Mac there's no such file, so sample
// values stand in.
import { existsSync, readFileSync } from "node:fs";
import { config } from "./config";

export interface BoxConfig {
  panelHost: string;
  /** Every app gets a free URL https://<slug>.<appsDomain>. */
  appsDomain: string;
  publicIp: string;
  version: string;
  defaultNode: string;
}

const DEV_BOX: BoxConfig = {
  panelHost: "203-0-113-7.sslip.io",
  appsDomain: "203-0-113-7.sslip.io",
  publicIp: "203.0.113.7",
  version: "dev",
  defaultNode: "24.13.1",
};

const BOX_CONFIG_FILE = process.env.LAYER_BOX_CONFIG ?? "/etc/layer/config.json";

export function boxConfig(): BoxConfig {
  if (!existsSync(BOX_CONFIG_FILE)) {
    if (config.isProd) throw new Error(`missing ${BOX_CONFIG_FILE} (re-run the installer)`);
    return DEV_BOX;
  }
  return JSON.parse(readFileSync(BOX_CONFIG_FILE, "utf8")) as BoxConfig;
}

/** The free URL host for an app: piqo → piqo.203-0-113-7.sslip.io */
export const freeHost = (slug: string, box: BoxConfig = boxConfig()) => `${slug}.${box.appsDomain}`;
