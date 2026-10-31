import type { LucideIcon } from "lucide-react";

export type IconSvgElement = LucideIcon;

/** A Lucide icon (as in AgentOS) at our default size and stroke. */
export function Icon({ icon: Glyph, size = 15, strokeWidth = 2, className }: { icon: LucideIcon; size?: number; strokeWidth?: number; className?: string }) {
  return <Glyph size={size} strokeWidth={strokeWidth} className={className ? `shrink-0 ${className}` : "shrink-0"} aria-hidden />;
}
