import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "../api/client";
import type { PublicUser } from "../api/types";
import { cn } from "../lib/cn";
import { Stamp } from "./ui/Stamp";

/** One or two characters match half the database — noisy for the user and
 * pointless load for us. Nothing is queried or shown below this. */
export const MIN_QUERY = 3;

/** Debounced username prefix search. Shared by the header box (dropdown)
 * and the /search page (results list). */
export function useUserSearch(query: string): { results: PublicUser[]; searching: boolean } {
  const [results, setResults] = useState<PublicUser[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const cleaned = query.trim().toLowerCase();
    if (cleaned.length < MIN_QUERY) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await api(`/users/search?q=${encodeURIComponent(cleaned)}`);
        const body = response.ok ? ((await response.json()) as PublicUser[]) : [];
        if (!cancelled) setResults(body);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return { results, searching };
}

export function UserRow({ user, onPick }: { user: PublicUser; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left hover:bg-paper-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      {user.avatar_url ? (
        <img
          src={user.avatar_url}
          alt=""
          className="h-8 w-8 shrink-0 rounded-full border-2 border-ink object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-ink bg-paper-deep font-mono text-xs uppercase"
        >
          {user.username[0]}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-mono text-sm lowercase">u/{user.username}</span>
        {user.display_name && (
          <span className="block truncate text-xs text-ink-soft">{user.display_name}</span>
        )}
      </span>
    </button>
  );
}

/** The header search: input + dropdown, Enter goes to the full page. */
export function SearchBox({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { results, searching } = useUserSearch(query);
  const rootRef = useRef<HTMLDivElement>(null);

  // close on outside click
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const go = (username: string) => {
    setOpen(false);
    setQuery("");
    navigate(`/u/${username}`);
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input
        type="search"
        value={query}
        placeholder="find u/…"
        aria-label="Search usernames"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && query.trim().length >= MIN_QUERY) {
            setOpen(false);
            navigate(`/search?q=${encodeURIComponent(query.trim())}`);
          }
          if (event.key === "Escape") setOpen(false);
        }}
        className="h-9 w-32 rounded-tag border-2 border-ink bg-paper-deep px-3 font-mono text-sm lowercase placeholder:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:w-44"
      />
      {open && query.trim().length > 0 && (
        <div className="absolute right-0 top-11 z-40 w-64 rounded-tag border-2 border-ink bg-paper p-1.5 shadow-tag">
          {query.trim().length < MIN_QUERY ? (
            <Stamp className="block px-3 py-2 text-[11px] text-ink-soft">
              Keep typing — {MIN_QUERY} letters minimum
            </Stamp>
          ) : searching && results.length === 0 ? (
            <Stamp className="block px-3 py-2 text-[11px] text-ink-soft">Searching…</Stamp>
          ) : results.length === 0 ? (
            <Stamp className="block px-3 py-2 text-[11px] text-ink-soft">No one by that name</Stamp>
          ) : (
            results.map((user) => (
              <UserRow key={user.username} user={user} onPick={() => go(user.username)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
