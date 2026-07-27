import { useId } from "react";
import type { ComponentPropsWithRef } from "react";

import { cn } from "../../lib/cn";

interface SelectProps extends ComponentPropsWithRef<"select"> {
  label: string;
  error?: string;
  hint?: string;
}

/** Native select (keyboard and screen-reader behavior for free), tag chrome. */
export function Select({ label, error, hint, id, className, children, ...rest }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const messageId = `${selectId}-message`;
  const message = error ?? hint;

  return (
    <div className={className}>
      <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <select
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className={cn(
            "h-11 w-full appearance-none rounded-tag border-2 border-ink bg-paper-deep px-3 pr-9 text-ink",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          )}
          {...rest}
        >
          {children}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 h-0 w-0 -translate-y-1/2 border-x-[5px] border-t-[6px] border-x-transparent border-t-ink"
        />
      </div>
      {message && (
        <p
          id={messageId}
          role={error ? "alert" : undefined}
          className={cn("mt-1.5 text-sm", error ? "text-danger" : "text-ink-soft")}
        >
          {message}
        </p>
      )}
    </div>
  );
}
