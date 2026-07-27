import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import type { ReactNode } from "react";

import { api, ApiError } from "../api/client";
import type { UserPrivate } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Stamp } from "../components/ui/Stamp";
import { AuthShell, FormError } from "./AuthShell";

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

type Availability = "idle" | "checking" | "available" | "taken";

export default function Register() {
  const { register, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [availability, setAvailability] = useState<Availability>("idle");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const normalized = username.trim().toLowerCase();
  const formatOk = USERNAME_RE.test(normalized);

  const next = params.get("next");
  const target = (them: UserPrivate) =>
    next !== null && next.startsWith("/") ? next : `/u/${them.username}`;

  useEffect(() => {
    if (user && !submitting) navigate(target(user), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, submitting, navigate]);

  // Live availability check, debounced 400ms
  useEffect(() => {
    if (!formatOk) {
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
        if (!cancelled) setAvailability("idle"); // network hiccup — the server recheck decides
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [normalized, formatOk]);

  const usernameStatus: { hint?: ReactNode; error?: string } =
    username.length === 0
      ? { hint: "3–20 characters: lowercase letters, digits, underscore." }
      : !formatOk
        ? { error: "3–20 characters: lowercase letters, digits, underscore." }
        : availability === "checking"
          ? { hint: <Stamp className="text-ink-soft">Checking…</Stamp> }
          : availability === "taken"
            ? { error: "Taken — try another." }
            : availability === "available"
              ? { hint: <Stamp>u/{normalized} — yours if you want it</Stamp> }
              : {};

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!formatOk) {
      setError("Pick a username first: 3–20 characters, lowercase letters, digits, underscore.");
      return;
    }
    if (availability === "taken") {
      setError("That username is taken. Pick another and resubmit.");
      return;
    }
    if (password.length < 8) {
      setError("Password needs at least 8 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await register(email.trim(), normalized, password);
      navigate(target(created), { state: next ? { authedReturn: true } : null });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create your wishlist"
      footer={
        <>
          Already have one?{" "}
          <Link to="/login" className="font-medium text-ink underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error && <FormError>{error}</FormError>}
        <Input
          label="Username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          inputClassName="font-mono lowercase"
          suffix={
            availability === "checking" ? (
              <span
                aria-hidden="true"
                className="h-4 w-4 rounded-full border-2 border-ink-soft border-r-transparent motion-safe:animate-spin"
              />
            ) : undefined
          }
          {...usernameStatus}
        />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          Create your wishlist
        </Button>
      </form>
    </AuthShell>
  );
}
