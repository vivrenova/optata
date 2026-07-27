import { useId } from "react";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "../../lib/cn";

interface InputProps extends ComponentPropsWithRef<"input"> {
  label: string;
  error?: string;
  hint?: ReactNode;
  suffix?: ReactNode;
  /** Extra classes for the input element itself (e.g. font-mono). */
  inputClassName?: string;
}

/** Inputs are recessed surfaces: paper-deep, ink border, no shadow. */
export function Input({
  label,
  error,
  hint,
  suffix,
  inputClassName,
  id,
  className,
  ...rest
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const message = error ?? hint;

  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className={cn(
            "h-11 w-full rounded-tag border-2 border-ink bg-paper-deep px-3 text-ink",
            "placeholder:text-ink-soft",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
            suffix ? "pr-10" : "",
            inputClassName,
          )}
          {...rest}
        />
        {suffix && (
          <span className="absolute inset-y-0 right-3 flex items-center">{suffix}</span>
        )}
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
