import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Navigate } from "react-router";

import { api, ApiError, apiJson, errorDetail } from "../api/client";
import type { UserPrivate } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { AppBar } from "../components/AppBar";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Stamp } from "../components/ui/Stamp";
import { Tag } from "../components/ui/Tag";
import { TextArea } from "../components/ui/TextArea";
import { useToast } from "../components/ui/Toast";
import { processImageFile } from "../lib/imagePipeline";
import { usernameLockUntil } from "../lib/usernameLock";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const HIDE_OWN_SHUFFLE_KEY = "optata.hideOwnShuffle";

export default function Settings() {
  const { user, booting } = useAuth();
  if (!booting && user === null) return <Navigate to="/login?next=/settings" replace />;
  if (user === null) return null; // booting — App shows the splash

  return (
    <>
      <AppBar />
      <main className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 pb-16 pt-6">
        <h1 className="font-display text-2xl font-semibold">Settings</h1>
        <AvatarSection user={user} />
        <ProfileSection user={user} />
        <UsernameSection user={user} />
        <PasswordSection />
        <ShuffleSection />
      </main>
    </>
  );
}

function SectionTag({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Tag className="px-5 pb-6 pt-1">
      <h2 className="mb-4 font-display text-lg font-semibold">{title}</h2>
      {children}
    </Tag>
  );
}

function AvatarSection({ user }: { user: UserPrivate }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onPick(file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      // avatars are small — 512px long edge is plenty
      const processed = await processImageFile(file, 512);
      URL.revokeObjectURL(processed.previewUrl);
      const body = new FormData();
      body.append("image", processed.blob, "avatar.webp");
      const response = await api("/users/me/avatar", { method: "POST", body });
      if (!response.ok) {
        const parsed: unknown = await response.json().catch(() => null);
        toast(errorDetail(parsed, "That didn't save. Try again."), "danger");
        return;
      }
      setUser((await response.json()) as UserPrivate);
      toast("New face, saved.");
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "That photo wouldn't process. Try another one.",
        "danger",
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <SectionTag title="Avatar">
      <div className="flex items-center gap-4">
        {user.avatar_url ? (
          <img
            src={user.avatar_url}
            alt="Your avatar"
            className="h-16 w-16 rounded-full border-2 border-ink object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="grid h-16 w-16 place-items-center rounded-full border-2 border-ink bg-paper-deep font-mono text-lg uppercase"
          >
            {user.username[0]}
          </span>
        )}
        <div className="flex flex-col gap-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label="Choose an avatar"
            onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
          />
          <Button variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>
            {user.avatar_url ? "Replace avatar" : "Upload avatar"}
          </Button>
        </div>
      </div>
    </SectionTag>
  );
}

function ProfileSection({ user }: { user: UserPrivate }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const updated = await apiJson<UserPrivate>("/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          display_name: displayName.trim() || null,
          bio: bio.trim() || null,
        }),
      });
      setUser(updated);
      toast("Saved. That's how they'll see you.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionTag title="Profile">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-tag border-2 border-danger px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
        <Input
          label="Display name"
          maxLength={40}
          hint="Optional — shown instead of your username."
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <TextArea
          label="Bio"
          maxLength={160}
          hint="A line or two about what you're into."
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={busy}>
          Save profile
        </Button>
      </form>
    </SectionTag>
  );
}

function UsernameSection({ user }: { user: UserPrivate }) {
  const { setUser } = useAuth();
  const toast = useToast();
  const lockedUntil = usernameLockUntil(user.username_changed_at);
  const [username, setUsername] = useState(user.username);
  const [availability, setAvailability] = useState<"idle" | "checking" | "available" | "taken">(
    "idle",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = username.trim().toLowerCase();
  const changed = normalized !== user.username;
  const formatOk = USERNAME_RE.test(normalized);

  useEffect(() => {
    if (!changed || !formatOk) {
      setAvailability("idle");
      return;
    }
    setAvailability("checking");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await api(
          `/users/check-username?username=${encodeURIComponent(normalized)}`,
        );
        const body = (await response.json()) as { available: boolean };
        if (!cancelled) setAvailability(body.available ? "available" : "taken");
      } catch {
        if (!cancelled) setAvailability("idle");
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [normalized, changed, formatOk]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!changed) return;
    if (!formatOk) {
      setError("3–20 characters: lowercase letters, digits, underscore.");
      return;
    }
    setBusy(true);
    try {
      const updated = await apiJson<UserPrivate>("/users/me", {
        method: "PATCH",
        body: JSON.stringify({ username: normalized }),
      });
      setUser(updated);
      toast("New handle, yours. Locked in for 30 days.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (lockedUntil) {
    return (
      <SectionTag title="Username">
        <div className="flex flex-col gap-2">
          <Input
            label="Username"
            value={user.username}
            disabled
            inputClassName="font-mono lowercase"
          />
          <Stamp className="text-[11px] text-danger">
            Locked until{" "}
            {lockedUntil.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} — you
            get one change every 30 days
          </Stamp>
        </div>
      </SectionTag>
    );
  }

  return (
    <SectionTag title="Username">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-tag border-2 border-danger px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
        <Input
          label="Username"
          value={username}
          inputClassName="font-mono lowercase"
          onChange={(e) => setUsername(e.target.value)}
          hint={
            !changed ? (
              "Changing it breaks old links to your wishlist, and locks changes for 30 days."
            ) : availability === "checking" ? (
              <Stamp className="text-ink-soft">Checking…</Stamp>
            ) : availability === "available" ? (
              <Stamp>u/{normalized} — free</Stamp>
            ) : undefined
          }
          error={
            changed && !formatOk
              ? "3–20 characters: lowercase letters, digits, underscore."
              : availability === "taken"
                ? "Taken — try another."
                : undefined
          }
        />
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!changed || availability === "taken"}
        >
          Change username
        </Button>
      </form>
    </SectionTag>
  );
}

function PasswordSection() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("New password needs at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match. Retype them.");
      return;
    }
    setBusy(true);
    try {
      await apiJson<void>("/users/me/password", {
        method: "PATCH",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password changed. Everywhere else is signed out.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionTag title="Password">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-tag border-2 border-danger px-3 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          hint="At least 8 characters."
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <Input
          label="Repeat it"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={busy}>
          Change password
        </Button>
      </form>
    </SectionTag>
  );
}

function ShuffleSection() {
  const [showShuffle, setShowShuffle] = useState(
    () => localStorage.getItem(HIDE_OWN_SHUFFLE_KEY) !== "1",
  );

  const toggle = (checked: boolean) => {
    setShowShuffle(checked);
    if (checked) localStorage.removeItem(HIDE_OWN_SHUFFLE_KEY);
    else localStorage.setItem(HIDE_OWN_SHUFFLE_KEY, "1");
  };

  return (
    <SectionTag title="Shuffle">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={showShuffle}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-0.5 h-5 w-5 accent-electric"
        />
        <span>
          <span className="block text-sm font-medium">Deal me my own cards too</span>
          <span className="block text-xs text-ink-soft">
            Guests always get the deck — this only changes what you see. Stored on this device.
          </span>
        </span>
      </label>
    </SectionTag>
  );
}
