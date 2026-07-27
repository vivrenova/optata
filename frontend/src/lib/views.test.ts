import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshViews() {
  vi.resetModules();
  return import("./views");
}

function okResponse() {
  return new Response(null, { status: 204 });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("view batching", () => {
  it("debounces multiple records into ONE deduplicated POST", async () => {
    const views = await freshViews();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    views.recordView("a");
    views.recordView("b");
    views.recordView("a"); // dup
    await vi.advanceTimersByTimeAsync(1600);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ item_ids: ["a", "b"] });
  });

  it("visibilitychange → hidden flushes immediately with keepalive", async () => {
    const views = await freshViews();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const unbind = views.bindViewFlushOnHide();
    views.recordView("x");
    // tab dies long before the 1.5s debounce
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect((init as RequestInit & { keepalive?: boolean }).keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ item_ids: ["x"] });

    unbind();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("empty pending set never fires a request", async () => {
    const views = await freshViews();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await views.flushViews();
    await views.flushViews({ keepalive: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed flush never throws at the caller", async () => {
    const views = await freshViews();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));

    views.recordView("a");
    await expect(vi.advanceTimersByTimeAsync(1600)).resolves.not.toThrow();
  });
});
