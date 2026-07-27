import type { ComponentPropsWithRef } from "react";

import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: Variant;
  loading?: boolean;
}

const raised =
  "border-2 border-ink shadow-tag " +
  "motion-safe:hover:-translate-x-px motion-safe:hover:-translate-y-px motion-safe:hover:shadow-tag-lift " +
  "active:translate-x-[2px] active:translate-y-[2px] active:shadow-none " +
  "disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-tag";

const variants: Record<Variant, string> = {
  // electric is the ONE static accent, reserved for primary actions
  primary: cn("bg-electric text-paper", raised),
  secondary: cn("bg-paper text-ink", raised),
  ghost: "text-ink hover:bg-paper-deep",
  danger: cn("bg-danger text-paper", raised),
};

export function Button({
  variant = "secondary",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex h-11 items-center justify-center gap-2 rounded-tag px-5 font-medium",
        "transition-[transform,box-shadow] duration-100",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin"
        />
      )}
      {children}
    </button>
  );
}
