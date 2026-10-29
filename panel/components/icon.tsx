import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export type { IconSvgElement };

/** A Hugeicons icon (stroke rounded, free set) at our default size and stroke. */
export function Icon({ icon, size = 18, strokeWidth = 1.5, className }: { icon: IconSvgElement; size?: number; strokeWidth?: number; className?: string }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} className={className ? `shrink-0 ${className}` : "shrink-0"} aria-hidden />;
}
