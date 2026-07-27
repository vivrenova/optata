import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { AppBar } from "../components/AppBar";
import { MIN_QUERY, UserRow, useUserSearch } from "../components/SearchBox";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Skeleton } from "../components/ui/Skeleton";
import { Tag } from "../components/ui/Tag";

export default function Search() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const urlQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const { results, searching } = useUserSearch(query);

  // keep the URL shareable without pushing a history entry per keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      const cleaned = query.trim();
      if (cleaned !== urlQuery) {
        setParams(cleaned ? { q: cleaned } : {}, { replace: true });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [query, urlQuery, setParams]);

  return (
    <>
      <AppBar />
      <main className="mx-auto w-full max-w-lg px-4 pb-16 pt-6">
        <h1 className="mb-4 font-display text-2xl font-semibold">Find a wishlist</h1>
        <Input
          label="Username"
          autoFocus
          value={query}
          inputClassName="font-mono lowercase"
          placeholder="bohdan"
          hint={`Prefix search — ${MIN_QUERY} letters minimum.`}
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="mt-6">
          {query.trim().length < MIN_QUERY ? (
            <EmptyState
              title="Whose wishes are you after?"
              body={`Type at least ${MIN_QUERY} letters of their username.`}
            />
          ) : searching && results.length === 0 ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : results.length === 0 ? (
            <EmptyState
              title="No one by that name yet"
              body="Check the spelling — or invite them to make a wishlist."
            />
          ) : (
            <Tag hole={false} className="p-2">
              <div className="flex flex-col">
                {results.map((user) => (
                  <UserRow
                    key={user.username}
                    user={user}
                    onPick={() => navigate(`/u/${user.username}`)}
                  />
                ))}
              </div>
            </Tag>
          )}
        </div>
      </main>
    </>
  );
}
