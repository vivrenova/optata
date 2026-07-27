import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ApiError } from "../api/client";
import type { UserPrivate } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { AuthShell, FormError } from "./AuthShell";

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = params.get("next");
  const target = (them: UserPrivate) =>
    next !== null && next.startsWith("/") ? next : `/u/${them.username}`;

  // Already signed in → nothing to do here
  useEffect(() => {
    if (user && !submitting) navigate(target(user), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, submitting, navigate]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const loggedIn = await login(email.trim(), password);
      // authedReturn tells the destination to explain what just unlocked
      navigate(target(loggedIn), { state: next ? { authedReturn: true } : null });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          New here?{" "}
          <Link to="/register" className="font-medium text-ink underline">
            Create your wishlist
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error && <FormError>{error}</FormError>}
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="text-sm">
          <Link to="/forgot-password" className="underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" variant="primary" loading={submitting} className="w-full">
          Log in
        </Button>
      </form>
    </AuthShell>
  );
}
