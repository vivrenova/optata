import { useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { api, ApiError, errorDetail } from "../../api/client";
import { formatPrice } from "../../api/types";
import type { OwnerItem, WishlistItem } from "../../api/types";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Stamp } from "../ui/Stamp";
import { useToast } from "../ui/Toast";
import { CardMedia } from "./CardMedia";

interface ReservationPatch {
  is_reserved: boolean;
  reserved_by_me: boolean;
}

export function ItemModal({
  item,
  ownerUsername,
  onClose,
  onReservationChange,
  onEdit,
  onDeleted,
}: {
  item: WishlistItem | null;
  ownerUsername: string;
  onClose: () => void;
  onReservationChange: (id: string, patch: ReservationPatch) => void;
  /** Owner-only actions (Stage 5). Absent for guests/anonymous. */
  onEdit?: (item: OwnerItem) => void;
  onDeleted?: (id: string) => void;
}) {
  return (
    <Modal open={item !== null} onClose={onClose} title={item?.title ?? ""}>
      {item && (
        <ItemModalBody
          item={item}
          ownerUsername={ownerUsername}
          onReservationChange={onReservationChange}
          onEdit={onEdit}
          onDeleted={onDeleted}
        />
      )}
    </Modal>
  );
}

function ItemModalBody({
  item,
  ownerUsername,
  onReservationChange,
  onEdit,
  onDeleted,
}: {
  item: WishlistItem;
  ownerUsername: string;
  onReservationChange: (id: string, patch: ReservationPatch) => void;
  onEdit?: (item: OwnerItem) => void;
  onDeleted?: (id: string) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [loginPrompt, setLoginPrompt] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function deleteItem() {
    if (item.view !== "owner") return;
    setBusy(true);
    try {
      const response = await api(`/items/${item.id}`, { method: "DELETE" });
      if (response.status === 204) {
        onDeleted?.(item.id);
        toast("Deleted. Gone for good.");
      } else {
        const parsed: unknown = await response.json().catch(() => null);
        toast(errorDetail(parsed, "That didn't go through. Try again."), "danger");
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Can't reach the server. Try again.", "danger");
    } finally {
      setBusy(false);
    }
  }

  const price = formatPrice(item.price, item.currency);

  async function reserve() {
    setBusy(true);
    try {
      const response = await api(`/items/${item.id}/reserve`, { method: "POST" });
      if (response.status === 201) {
        onReservationChange(item.id, { is_reserved: true, reserved_by_me: true });
        toast(`Saved to your reservations. ${ownerUsername} won't know.`);
      } else if (response.status === 409) {
        onReservationChange(item.id, { is_reserved: true, reserved_by_me: false });
        toast("Someone beat you to it — it's already being gifted.", "danger");
      } else {
        const body: unknown = await response.json().catch(() => null);
        toast(errorDetail(body, "That didn't go through. Try again."), "danger");
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Can't reach the server. Try again.", "danger");
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    setBusy(true);
    try {
      const response = await api(`/items/${item.id}/reserve`, { method: "DELETE" });
      if (response.status === 204) {
        onReservationChange(item.id, { is_reserved: false, reserved_by_me: false });
        toast("Reservation released.");
      } else {
        const body: unknown = await response.json().catch(() => null);
        toast(errorDetail(body, "That didn't go through. Try again."), "danger");
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Can't reach the server. Try again.", "danger");
    } finally {
      setBusy(false);
    }
  }

  const goToLogin = (path: "/login" | "/register") =>
    navigate(`${path}?next=${encodeURIComponent(location.pathname)}`);

  return (
    <div className="flex flex-col gap-4">
      <CardMedia item={item} fit="natural" />

      <div className="flex items-baseline justify-between gap-3">
        {price ? <Stamp className="text-base">{price}</Stamp> : <span />}
        {item.view === "owner" && (
          <Stamp className="text-[11px] opacity-70">{item.view_count} views</Stamp>
        )}
      </div>

      {item.note && <p className="text-sm leading-relaxed text-ink-soft">{item.note}</p>}

      {item.link && (
        <Button
          variant="secondary"
          onClick={() => window.open(item.link ?? "", "_blank", "noopener,noreferrer")}
        >
          Open the shop page ↗
        </Button>
      )}

      {/* reservation zone — what renders here is decided by the TYPE of the
          payload, not by flags */}
      {item.view === "guest" &&
        (item.reserved_by_me ? (
          <div className="flex flex-col gap-2">
            <Stamp>You're gifting this</Stamp>
            <Button variant="ghost" loading={busy} onClick={() => void release()} className="text-danger">
              Release reservation
            </Button>
          </div>
        ) : item.is_reserved ? (
          <Stamp className="py-1">Already being gifted</Stamp>
        ) : (
          <Button variant="primary" loading={busy} onClick={() => void reserve()}>
            I'll gift this
          </Button>
        ))}

      {/* owner actions — edit and a two-step delete. Copy stays neutral
          about reservations: the owner must learn nothing from this modal. */}
      {item.view === "owner" && onEdit && onDeleted && (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => onEdit(item)}>
            Edit
          </Button>
          {confirmingDelete ? (
            <div className="flex flex-col gap-2 rounded-[10px] border-2 border-danger p-3">
              <p className="text-sm">Delete for good? The photo goes too.</p>
              <Button variant="danger" loading={busy} onClick={() => void deleteItem()}>
                Delete forever
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep it
              </Button>
            </div>
          ) : (
            <Button variant="ghost" className="text-danger" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          )}
        </div>
      )}

      {item.view === "anonymous" &&
        (loginPrompt ? (
          <div className="flex flex-col gap-3 rounded-[10px] border-2 border-ink bg-paper-deep p-4">
            <h3 className="font-display text-lg font-semibold">Reserving needs an account</h3>
            <p className="text-sm leading-relaxed">
              Gift statuses are private between gift-givers — {ownerUsername} never sees who
              reserved what, or that anything was reserved at all. Log in and this wishlist
              will show you what's still free, so nobody doubles up.
            </p>
            <div className="flex flex-col gap-2">
              <Button variant="primary" onClick={() => goToLogin("/login")}>
                Log in
              </Button>
              <Button variant="ghost" onClick={() => goToLogin("/register")}>
                Create an account
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" onClick={() => setLoginPrompt(true)}>
            I'll gift this
          </Button>
        ))}
    </div>
  );
}
