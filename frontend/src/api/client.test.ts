import { afterEach, describe, expect, it, vi } from "vitest";

/** Fresh module per test — the client keeps single-flight state at module level. */
async function freshClient() {
  vi.resetModules();
  return import("./client");
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const tokenOut = {
  access_token: "jwt-1",
  token_type: "bearer",
  user: { id: "u1", username: "bo", email: "b@e.co" },
};

const INVALID_TOKEN = { "WWW-Authenticate": 'Bearer error="invalid_token"' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("single-flight refresh", () => {
  it("concurrent 401s share exactly one refresh call", async () => {
    const client = await freshClient();
    client.setAccessToken("stale-jwt");

    let refreshCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/auth/refresh")) {
          refreshCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20)); // let both 401s land first
          return jsonResponse(200, tokenOut);
        }
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth === "Bearer jwt-1") return jsonResponse(200, { ok: true });
        return jsonResponse(401, { detail: "Access token expired." }, INVALID_TOKEN);
      }),
    );

    const [a, b] = await Promise.all([client.api("/users/me"), client.api("/users/me")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refreshCalls).toBe(1);
  });

  it("a 401 from /auth/refresh means guest and NEVER triggers another refresh", async () => {
    const client = await freshClient();
    const fetchMock = vi.fn(async () => jsonResponse(401, { detail: "Not authenticated." }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.refreshSession();
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no loop, no second attempt
    expect(client.getAccessToken()).toBeNull();
  });

  it("bootstrapSession never fires twice, even when called twice (StrictMode)", async () => {
    const client = await freshClient();
    const fetchMock = vi.fn(async () => jsonResponse(200, tokenOut));
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([client.bootstrapSession(), client.bootstrapSession()]);
    await client.bootstrapSession(); // and a third time, after settling
    expect(a?.access_token).toBe("jwt-1");
    expect(b?.access_token).toBe("jwt-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("errorDetail humanizes raw Pydantic validation output", () => {
  it("email format errors become plain copy, not a parser trace", async () => {
    const client = await freshClient();
    const body = {
      detail: [
        {
          type: "value_error",
          loc: ["body", "email"],
          msg: "value is not a valid email address: The part after the @-sign is missing.",
        },
      ],
    };
    expect(client.errorDetail(body, "x")).toBe(
      "That doesn't look like an email address. Check it and try again.",
    );
  });

  it("too-short passwords get the human minimum", async () => {
    const client = await freshClient();
    const body = {
      detail: [
        {
          type: "string_too_short",
          loc: ["body", "password"],
          msg: "String should have at least 8 characters",
          ctx: { min_length: 8 },
        },
      ],
    };
    expect(client.errorDetail(body, "x")).toBe("Password needs at least 8 characters.");
  });

  it("missing fields name the field", async () => {
    const client = await freshClient();
    const body = { detail: [{ type: "missing", loc: ["body", "title"], msg: "Field required" }] };
    expect(client.errorDetail(body, "x")).toBe("Fill in the title field.");
  });

  it("too-long fields name the limit", async () => {
    const client = await freshClient();
    const body = {
      detail: [
        {
          type: "string_too_long",
          loc: ["body", "note"],
          msg: "String should have at most 280 characters",
          ctx: { max_length: 280 },
        },
      ],
    };
    expect(client.errorDetail(body, "x")).toBe("The note is limited to 280 characters.");
  });

  it("custom validator copy passes through with the prefix stripped", async () => {
    const client = await freshClient();
    const body = {
      detail: [
        {
          type: "value_error",
          loc: ["body", "username"],
          msg: "Value error, Username must be 3-20 characters: lowercase letters, digits, underscore.",
        },
      ],
    };
    expect(client.errorDetail(body, "x")).toBe(
      "Username must be 3-20 characters: lowercase letters, digits, underscore.",
    );
  });

  it("plain string details are returned untouched", async () => {
    const client = await freshClient();
    expect(client.errorDetail({ detail: "This username is taken." }, "x")).toBe(
      "This username is taken.",
    );
  });
});

describe("RFC 6750 challenge handling", () => {
  it("invalid_token → one refresh, one retry", async () => {
    const client = await freshClient();
    client.setAccessToken("stale-jwt");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        calls.push(path);
        if (path.endsWith("/auth/refresh")) return jsonResponse(200, tokenOut);
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth === "Bearer jwt-1") return jsonResponse(200, { ok: true });
        return jsonResponse(401, { detail: "Access token expired." }, INVALID_TOKEN);
      }),
    );

    const response = await client.api("/reservations");
    expect(response.status).toBe(200);
    expect(calls.filter((c) => c.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith("/reservations"))).toHaveLength(2);
  });

  it("a plain-Bearer 401 (no token presented) does NOT attempt a refresh", async () => {
    const client = await freshClient();
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { detail: "Not authenticated." }, { "WWW-Authenticate": "Bearer" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await client.api("/reservations");
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh call went out
  });

  it("failed refresh after invalid_token hard-logs-out via the registered handler", async () => {
    const client = await freshClient();
    client.setAccessToken("stale-jwt");
    const expired = vi.fn();
    client.onSessionExpired(expired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).endsWith("/auth/refresh")) {
          return jsonResponse(401, { detail: "Session expired." });
        }
        return jsonResponse(401, { detail: "Access token expired." }, INVALID_TOKEN);
      }),
    );

    const response = await client.api("/reservations");
    expect(response.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(client.getAccessToken()).toBeNull();
  });
});
