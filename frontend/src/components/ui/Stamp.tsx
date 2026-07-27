import type { ComponentPropsWithRef } from "react";

import { cn } from "../../lib/cn";

/**
 * Stamped information — prices, view counts, usernames, small labels.
 * Mono, uppercase, letter-spaced: printed on the tag, not typeset in it.
 */
export function Stamp({ className, children, ...rest }: ComponentPropsWithRef<"span">) {
  return (
    <span
      className={cn("font-mono text-xs uppercase tracking-[0.08em] text-ink", className)}
      {...rest}
    >
      {children}
    </span>
  );
}
