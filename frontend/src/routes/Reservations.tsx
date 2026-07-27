import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";

import { api, ApiError, apiJson, errorDetail } from "../api/client";
import { formatPrice } from "../api/types";
import type { ReservationEntry } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { AppBar } from "../components/AppBar";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton } from "../components/ui/Skeleton";
import { Stamp } from "../components/ui/Stamp";
import { Tag } from "../components/ui/Tag";
import { useToast } from "../components/ui/Toast";
import { muteAccent } from "../lib/color";

type Status =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; entries: ReservationEntry[] };

export default function Reservations() {
  const { user, booting } = useAuth();
  if (!booting && user === null) return <Navigate to="/login?next=/reservations" replace />;
  if (user === null) return null;
  return <ReservationsBody />;
}

function ReservationsBody() {
  const toast = useToast();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    void (async () => {
      try {
        const entries = await apiJson<ReservationEntry[]>("/reservations");
        if (!cancelled) setStatus({ kind: "ready", entries });
      } catch {
        if (!cancelled) setStatus({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const removeEntry = (id: string) =>
    setStatus((current) =>
      current.kind === "ready"
        ? { kind: "ready", entries: current.entries.filter((entry) => entry.id !== id) }
        : current,
    );

  async function release(entry: ReservationEntry) {
    if (!entry.item) return;
    try {
      const response = await api(`/items/${entry.item.id}/reserve`, { method: "DELETE" });
      if (response.status === 204) {
        removeEntry(entry.id);
        toast("Let go. It's up for grabs again.");
      } else {
        const parsed: unknown = await response.json().catch(() => null);
        toast(errorDetail(parsed, "That didn't go through. Try again."), "danger");
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Can't reach the server. Try that again.", "danger");
    }
  }

  async function dismiss(entry: ReservationEntry) {
    try {
      await apiJson<void>(`/reservations/${entry.id}`, { method: "DELETE" });
      removeEntry(entry.id);
      toast("Cleared off your list.");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Can't reach the server. Try that again.", "danger");
    }
  }

  return (
    <>
      <AppBar />
      <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-16 pt-6">
        <h1 className="font-display text-2xl font-semibold">What you're gifting</h1>
        <p className="-mt-2 text-sm text-ink-soft">
          Only you can see this page. No owner ever finds out what's taken — that's the
          whole point.
        </p>

        {status.kind === "loading" && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        )}

        {status.kind === "error" && (
          <EmptyState
            title="Couldn't load your list"
            body="The server didn't answer. It naps on free hosting — give it a moment."
            action={
              <Button variant="primary" onClick={() => setReloadKey((k) => k + 1)}>
                Try again
              </Button>
            }
          />
        )}

        {status.kind === "ready" &&
          (status.entries.length === 0 ? (
            <EmptyState
              title="You haven't called dibs on anything"
              body="Open a friend's wishlist and claim something. They'll never know it was you."
              action={
                <Button variant="primary" onClick={() => navigate("/search")}>
                  Find a wishlist
                </Button>
              }
            />
          ) : (
            status.entries.map((entry) =>
              entry.item ? (
                <Tag key={entry.id} hole={false} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <img
                      src={entry.item.image_url}
                      alt=""
                      className="h-16 w-16 shrink-0 rounded-[10px] border-2 object-cover"
                      style={{ borderColor: muteAccent(entry.item.accent_color) }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-display text-base font-semibold">
                        {entry.item.title}
                      </p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {formatPrice(entry.item.price, entry.item.currency) && (
                          <Stamp className="text-[11px]">
                            {formatPrice(entry.item.price, entry.item.currency)}
                          </Stamp>
                        )}
                        <Link
                          to={`/u/${entry.item.owner_username}`}
                          className="font-mono text-xs lowercase underline-offset-4 hover:underline"
                        >
                          u/{entry.item.owner_username}
                        </Link>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      className="h-9 shrink-0 px-3 text-sm text-danger"
                      onClick={() => void release(entry)}
                    >
                      Let go
                    </Button>
                  </div>
                </Tag>
              ) : (
                <Tag
                  key={entry.id}
                  hole={false}
                  surface="var(--color-paper-deep)"
                  className="px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <Stamp className="text-[11px] text-ink-soft">No longer on their list</Stamp>
                      <p className="truncate font-display text-base font-semibold text-ink-soft">
                        {entry.tombstone?.title ?? "—"}
                      </p>
                      {entry.tombstone && (
                        <p className="font-mono text-xs lowercase text-ink-soft">
                          u/{entry.tombstone.owner_username} removed it
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      className="h-9 shrink-0 px-3 text-sm"
                      onClick={() => void dismiss(entry)}
                    >
                      Clear it
                    </Button>
                  </div>
                </Tag>
              ),
            )
          ))}
      </main>
    </>
  );
}
