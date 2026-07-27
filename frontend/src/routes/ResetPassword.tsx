import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ApiError, apiJson } from "../api/client";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { AuthShell, FormError } from "./AuthShell";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Malformed link: no token at all
  if (!token) {
    return (
      <AuthShell title="This link is broken">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-soft">
            The reset link is missing its token — it probably got cut in half by your mail app.
          </p>
          <Button variant="primary" onClick={() => navigate("/forgot-password")} className="w-full">
            Request a new link
          </Button>
        </div>
      </AuthShell>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password needs at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match. Retype them.");
      return;
    }
    setSubmitting(true);
    try {
      await apiJson("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, new_password: password }),
      });
      setDone(true);
    } catch (err) {
      // The server distinguishes invalid / expired / already-used links
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="Password changed">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-soft">
            All other sessions are signed out. Log in with the new password.
          </p>
          <Button variant="primary" onClick={() => navigate("/login")} className="w-full">
            Log in
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set a new password"
      footer={
        <Link to="/forgot-password" className="font-medium text-ink underline">
          Request a new link
        </Link>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error && <FormError>{error}</FormError>}
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Input
          label="Repeat it"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          Change password
        </Button>
      </form>
    </AuthShell>
  );
}
