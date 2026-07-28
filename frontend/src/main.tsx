import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";

import App from "./App";

// Opt-in via env: no DSN, no Sentry, no network calls. Local dev and the
// test suite therefore run completely untouched by it.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    // Errors only. No tracing, no session replay: replay would record the
    // deck — including which items are marked as already taken — and that
    // is exactly the secret this product exists to keep.
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
