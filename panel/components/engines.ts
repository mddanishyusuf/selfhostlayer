// How each database engine looks wherever the panel lists one: its name,
// icon and tint, as in the approved prototype (design/dashboard-light.html).
import { BoxIcon, DatabaseIcon, ZapIcon } from "lucide-react";
import type { Engine } from "@/lib/browse";
import type { IconSvgElement } from "./icon";
import type { TileTone } from "./page";

export const ENGINE_LOOK: Record<Engine, { name: string; icon: IconSvgElement; tone: TileTone }> = {
  sqlite: { name: "SQLite", icon: DatabaseIcon, tone: "blue" },
  postgres: { name: "Postgres", icon: DatabaseIcon, tone: "lav" },
  redis: { name: "Redis", icon: ZapIcon, tone: "rose" },
  mongodb: { name: "MongoDB", icon: BoxIcon, tone: "teal" },
  mysql: { name: "MySQL", icon: DatabaseIcon, tone: "coral" },
};
