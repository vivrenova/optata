import type { ReactNode } from "react";
import { Link } from "react-router";

import { Tag } from "../components/ui/Tag";
import { Wordmark } from "../components/Wordmark";

interface AuthShellProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthShell({ title, children, footer }: AuthShellProps) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-6 block text-center">
          <Wordmark />
        </Link>
        <Tag className="px-5 pb-7 pt-1 sm:px-7">
          <h1 className="mb-5 font-display text-2xl font-semibold">{title}</h1>
          {children}
        </Tag>
        {footer && <div className="mt-4 text-center text-sm text-ink-soft">{footer}</div>}
      </div>
    </main>
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-tag border-2 border-danger px-3 py-2.5 text-sm text-danger">
      {children}
    </p>
  );
}
