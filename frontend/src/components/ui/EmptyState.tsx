import type { ReactNode } from "react";

import { Tag } from "./Tag";

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
}

/** An empty screen is an invitation to act, not a mood. */
export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <Tag className="mx-auto w-full max-w-sm px-6 pb-10 pt-4 text-center">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      {body && <p className="mt-2 text-sm text-ink-soft">{body}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </Tag>
  );
}
