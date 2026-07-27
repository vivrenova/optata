import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";

import { ApiError, apiJson } from "../api/client";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { AuthShell, FormError } from "./AuthShell";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiJson("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      footer={
        <Link to="/login" className="font-medium text-ink underline">
          Back to log in
        </Link>
      }
    >
      {sent ? (
        <div className="flex flex-col gap-3">
          <p>If that email is registered, a reset link is on its way.</p>
          <p className="text-sm text-ink-soft">
            The link works for 1 hour. Check spam if it doesn't show up.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {error && <FormError>{error}</FormError>}
          <p className="text-sm text-ink-soft">
            Enter your email and we'll send a link to set a new password.
          </p>
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={submitting} className="w-full">
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
