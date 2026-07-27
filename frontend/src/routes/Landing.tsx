import { Link, Navigate, useNavigate } from "react-router";

import { useAuth } from "../auth/AuthContext";
import { DemoDeck } from "../components/landing/DemoDeck";
import { Button } from "../components/ui/Button";
import { Stamp } from "../components/ui/Stamp";
import { Wordmark } from "../components/Wordmark";

/** One screen. The demo IS the pitch — nothing competes with it. */
export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (user) return <Navigate to={`/u/${user.username}`} replace />;

  return (
    // overflow-x-clip (NOT hidden — hidden would create a scroll container):
    // the demo's outgoing card translates far past the viewport edge, and a
    // transformed child otherwise grows the document's scrollable width →
    // a flashing horizontal scrollbar on every swipe. Clipping here contains
    // any horizontal overflow on the landing, at rest and mid-flight,
    // without touching body or vertical scroll.
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4">
        <Wordmark size="sm" />
        <Link to="/login" className="text-sm underline underline-offset-4">
          Log in
        </Link>
      </header>

      <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-10 px-4 pb-14 pt-4 md:grid-cols-2">
        <section className="max-w-md">
          <h1 className="font-display text-4xl font-extrabold leading-[1.05] sm:text-5xl">
            Your wishes as a deck of cards, not a spreadsheet.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-ink-soft">
            Add what you want, share one link. Friends swipe through and quietly call dibs —
            you never find out what's taken.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => navigate("/register")} className="px-7">
              Create your wishlist
            </Button>
          </div>
          <Stamp className="mt-6 block text-[11px] text-ink-soft">
            No feeds · no algorithms · one link
          </Stamp>
        </section>

        <section aria-label="Live demo" className="flex flex-col items-center gap-4">
          <DemoDeck />
          <Stamp className="text-[11px] text-ink-soft">
            Swipe or click — that's the whole idea
          </Stamp>
        </section>
      </main>
    </div>
  );
}
