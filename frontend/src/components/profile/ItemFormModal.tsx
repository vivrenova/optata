import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { api, ApiError, errorDetail } from "../../api/client";
import type { OwnerItem } from "../../api/types";
import { processImageFile } from "../../lib/imagePipeline";
import type { ProcessedImage } from "../../lib/imagePipeline";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Stamp } from "../ui/Stamp";
import { TextArea } from "../ui/TextArea";
import { useToast } from "../ui/Toast";
import { CardMedia } from "./CardMedia";

const CURRENCIES = ["UAH", "USD", "EUR", "PLN"] as const;

export type ItemFormState = { mode: "create" } | { mode: "edit"; item: OwnerItem };

/**
 * Create/edit a wish. The photo is the hero of the form too: the live
 * preview is a real tag body with the extracted accent already muted and
 * applied, before anything is uploaded. The client pipeline (resize →
 * WebP → accent) runs on file pick; the server still re-encodes and
 * strips EXIF — this is an optimization, not the safety net.
 */
export function ItemFormModal({
  state,
  onClose,
  onSaved,
}: {
  state: ItemFormState | null;
  onClose: () => void;
  onSaved: (item: OwnerItem, mode: "create" | "edit") => void;
}) {
  const toast = useToast();
  const editing = state?.mode === "edit" ? state.item : null;

  const [processed, setProcessed] = useState<ProcessedImage | null>(null);
  const [processing, setProcessing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // (re)fill on open
  useEffect(() => {
    if (state === null) return;
    setProcessed(null);
    setPhotoError(null);
    setFormError(null);
    setTitle(editing?.title ?? "");
    setLink(editing?.link ?? "");
    setPrice(editing?.price ? editing.price.replace(/\.00$/, "") : "");
    setCurrency(editing?.currency ?? "");
    setNote(editing?.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // free the preview object URL
  useEffect(() => {
    return () => {
      if (processed) URL.revokeObjectURL(processed.previewUrl);
    };
  }, [processed]);

  if (state === null) return null;

  const previewItem: OwnerItem | null = processed
    ? {
        view: "owner",
        id: "preview",
        title: title || "Your wish",
        image_url: processed.previewUrl,
        accent_color: processed.accentHex,
        link: null,
        price: null,
        currency: null,
        note: null,
        order_index: 0,
        view_count: 0,
      }
    : editing;

  async function onPickFile(file: File | null) {
    if (!file) return;
    setPhotoError(null);
    setProcessing(true);
    try {
      const result = await processImageFile(file);
      setProcessed((old) => {
        if (old) URL.revokeObjectURL(old.previewUrl);
        return result;
      });
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Couldn't process that photo.");
    } finally {
      setProcessing(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setFormError("Give it a title — that's the one required word.");
      return;
    }
    if (state!.mode === "create" && !processed) {
      setFormError("Add a photo — a wish without one is just a note.");
      return;
    }
    const hasPrice = price.trim() !== "";
    const hasCurrency = currency !== "";
    if (hasPrice !== hasCurrency) {
      setFormError("Price and currency go together — set both or neither.");
      return;
    }
    if (hasPrice && !/^\d+([.,]\d{1,2})?$/.test(price.trim())) {
      setFormError("Price must be a number like 1200 or 49.99.");
      return;
    }
    const cleanLink = link.trim();
    if (cleanLink && !/^https?:\/\//.test(cleanLink)) {
      setFormError("Link must start with http:// or https://.");
      return;
    }

    const body = new FormData();
    const normalizedPrice = price.trim().replace(",", ".");

    if (state!.mode === "create") {
      body.append("image", processed!.blob, "photo.webp");
      body.append("accent_color", processed!.accentHex);
      body.append("title", cleanTitle);
      if (cleanLink) body.append("link", cleanLink);
      if (hasPrice) {
        body.append("price", normalizedPrice);
        body.append("currency", currency);
      }
      if (note.trim()) body.append("note", note.trim());
    } else {
      const item = editing!;
      if (processed) {
        body.append("image", processed.blob, "photo.webp");
        body.append("accent_color", processed.accentHex);
      }
      if (cleanTitle !== item.title) body.append("title", cleanTitle);
      if (cleanLink !== (item.link ?? "")) body.append("link", cleanLink);
      const oldPrice = item.price ? item.price.replace(/\.00$/, "") : "";
      if (normalizedPrice !== oldPrice || currency !== (item.currency ?? "")) {
        body.append("price", hasPrice ? normalizedPrice : "");
        body.append("currency", hasCurrency ? currency : "");
      }
      if (note.trim() !== (item.note ?? "")) body.append("note", note.trim());
      let hasChanges = false;
      body.forEach(() => {
        hasChanges = true;
      });
      if (!hasChanges) {
        onClose();
        return;
      }
    }

    setSubmitting(true);
    try {
      const response =
        state!.mode === "create"
          ? await api("/items", { method: "POST", body })
          : await api(`/items/${editing!.id}`, { method: "PATCH", body });
      if (!response.ok) {
        const parsed: unknown = await response.json().catch(() => null);
        setFormError(errorDetail(parsed, "That didn't save. Try again."));
        return;
      }
      const saved = (await response.json()) as Omit<OwnerItem, "view">;
      const ownerItem: OwnerItem = { ...saved, price: saved.price == null ? null : String(saved.price), view: "owner" };
      onSaved(ownerItem, state!.mode);
      toast(state!.mode === "create" ? "Added. Deal it to your friends." : "Saved.");
      onClose();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Can't reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={state.mode === "create" ? "Add a wish" : "Edit wish"}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        {formError && (
          <p role="alert" className="rounded-tag border-2 border-danger px-3 py-2.5 text-sm text-danger">
            {formError}
          </p>
        )}

        {/* the photo IS the hero — preview first, fields after */}
        <div className="flex flex-col gap-2">
          {previewItem ? (
            // once chosen, the photo is the hero at its natural tag size
            <CardMedia item={previewItem} fit="natural" />
          ) : (
            // empty state stays compact — a full-bleed 3:4 dropzone pushes
            // every field below the fold before the user has typed anything
            <div className="grid h-24 w-full place-items-center rounded-[10px] border-2 border-dashed border-ink-soft">
              <Stamp className="text-ink-soft">The photo goes here</Stamp>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="Choose a photo"
            onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="secondary"
            loading={processing}
            onClick={() => fileInputRef.current?.click()}
          >
            {processed || editing ? "Replace the photo" : "Choose a photo"}
          </Button>
          {processed && (
            <Stamp className="text-[11px] text-ink-soft">
              {Math.round(processed.blob.size / 1024)} KB · {processed.width}×{processed.height} ·{" "}
              {processed.accentHex}
            </Stamp>
          )}
          {photoError && (
            <p role="alert" className="text-sm text-danger">
              {photoError}
            </p>
          )}
        </div>

        <Input
          label="Title"
          required
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Input
          label="Link"
          type="url"
          placeholder="https://… — optional, where to buy it"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Price"
            inputMode="decimal"
            placeholder="1200"
            inputClassName="font-mono"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <Select label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">No price</option>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </div>
        <TextArea
          label="Note"
          rows={2}
          maxLength={280}
          hint="Optional — size, colour, “the blue one, not the teal one”."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          {state.mode === "create" ? "Add to my wishlist" : "Save changes"}
        </Button>
      </form>
    </Modal>
  );
}
