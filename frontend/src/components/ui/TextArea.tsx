import { useId } from "react";
import type { ComponentPropsWithRef } from "react";

import { cn } from "../../lib/cn";

interface TextAreaProps extends ComponentPropsWithRef<"textarea"> {
  label: string;
  error?: string;
  hint?: string;
}

export function TextArea({ label, error, hint, id, className, rows = 3, ...rest }: TextAreaProps) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const messageId = `${areaId}-message`;
  const message = error ?? hint;

  return (
    <div className={className}>
      <label htmlFor={areaId} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={areaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={cn(
          "w-full resize-y rounded-tag border-2 border-ink bg-paper-deep px-3 py-2.5 text-ink",
          "placeholder:text-ink-soft",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        )}
        {...rest}
      />
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
