import type { ComponentPropsWithRef } from "react";

import { cn } from "../../lib/cn";

export function Skeleton({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-tag bg-paper-deep motion-safe:animate-pulse", className)}
      {...rest}
    />
  );
}
