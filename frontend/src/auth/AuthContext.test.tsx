import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthProvider bootstrap", () => {
  it("StrictMode double-mount produces exactly ONE refresh call", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, {
        access_token: "jwt-1",
        token_type: "bearer",
        user: { id: "u1", username: "bohdan", email: "b@e.co" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { AuthProvider, useAuth } = await import("./AuthContext");

    function Probe() {
      const { user, booting } = useAuth();
      return <output>{booting ? "booting" : (user?.username ?? "guest")}</output>;
    }

    await act(async () => {
      render(
        <StrictMode>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </StrictMode>,
      );
    });

    expect(await screen.findByText("bohdan")).toBeDefined();
    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/auth/refresh"),
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it("refresh 401 settles as guest without flashing a user", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { detail: "Not authenticated." })),
    );

    const { AuthProvider, useAuth } = await import("./AuthContext");

    function Probe() {
      const { user, booting } = useAuth();
      return <output>{booting ? "booting" : (user?.username ?? "guest")}</output>;
    }

    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });

    expect(await screen.findByText("guest")).toBeDefined();
  });
});
