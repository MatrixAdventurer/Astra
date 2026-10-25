// @vitest-environment node
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { cookies } from "next/headers";
import { WebRuntimeClient } from "@/lib/runtime-client/server";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, type RuntimeConfig } from "@/lib/runtime-config";

beforeEach(() => vi.mocked(cookies).mockReset());
afterEach(() => vi.unstubAllGlobals());

function runtimeConfig(accessToken: string, refreshToken: string): RuntimeConfig {
  return {
    mode: "live", source: "cookie", apiUrl: "https://example.test",
    accessToken, refreshToken, demoMode: false,
    hasAccessToken: true, hasRefreshToken: true, message: "",
  };
}

it("persists refreshed httpOnly cookies before the initiating SDK request completes", async () => {
  let release!: () => void;
  const available = new Promise<void>(resolve => { release = resolve; });
  const set = vi.fn();
  vi.mocked(cookies).mockImplementation(async () => {
    await available;
    // This consumer only uses the cookie store's setter.
    return { set } as unknown as Awaited<ReturnType<typeof cookies>>;
  });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/refresh")) {
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
    }
    return new Headers(init?.headers).get("Authorization") === "Bearer new-access"
      ? Response.json({ user_id: "alice" }) : Response.json({}, { status: 401 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const runtime = new WebRuntimeClient(runtimeConfig("old-access", "old-refresh"));
  const settled = vi.fn();
  const pending = runtime.sdk.getMe();
  void pending.then(settled, settled);
  await vi.waitFor(() => expect(cookies).toHaveBeenCalledTimes(1));
  expect(settled).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  await expect(runtime.get("/auth/me", { auth: "required" })).resolves.toEqual({ user_id: "alice" });
  expect(settled).not.toHaveBeenCalled();
  release();
  await expect(pending).resolves.toEqual({ user_id: "alice" });
  const options = { httpOnly: true, sameSite: "lax", path: "/" };
  expect(set.mock.calls).toEqual([
    [ACCESS_TOKEN_COOKIE, "new-access", options],
    [REFRESH_TOKEN_COOKIE, "new-refresh", options],
  ]);
  expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual([
    "Bearer old-access", null, "Bearer new-access", "Bearer new-access",
  ]);
});

it.each([
  { name: "SDK notification", sdkRefresh: true },
  { name: "Web transport", sdkRefresh: false },
])("keeps the newest usable cookies when the $name refresh finishes before an older notification", async ({ sdkRefresh }) => {
  let release!: () => void;
  const available = new Promise<void>(resolve => { release = resolve; });
  const jar = new Map<string, string>();
  const set = vi.fn((name: string, value: string) => { jar.set(name, value); });
  vi.mocked(cookies).mockImplementation(async () => {
    if (vi.mocked(cookies).mock.calls.length === 1) await available;
    return { set } as unknown as Awaited<ReturnType<typeof cookies>>;
  });

  const issued = new Set(["access-0"]);
  const expired = new Set(["access-0"]);
  const refreshRequests: string[] = [];
  let rotation = 0;
  let validRefresh = "refresh-0";
  const unauthorized = () => Response.json({ detail: "Unauthorized" }, { status: 401 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/refresh")) {
      const token = JSON.parse(String(init?.body)).refresh_token;
      refreshRequests.push(token);
      if (token !== validRefresh) return unauthorized();
      rotation++;
      validRefresh = `refresh-${rotation}`;
      const access = `access-${rotation}`;
      issued.add(access);
      return Response.json({ access_token: access, refresh_token: validRefresh });
    }
    const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "");
    return token && issued.has(token) && !expired.has(token)
      ? Response.json({ user_id: "alice" }) : unauthorized();
  }));

  const runtime = new WebRuntimeClient(runtimeConfig("access-0", "refresh-0"));
  const first = Promise.allSettled([runtime.sdk.getMe()]);
  await vi.waitFor(() => expect(cookies).toHaveBeenCalledTimes(1));
  expired.add("access-1");
  if (sdkRefresh) {
    await expect(runtime.sdk.getMe()).resolves.toEqual({ user_id: "alice" });
  } else {
    await expect(runtime.get("/auth/me", { auth: "required" })).resolves.toEqual({ user_id: "alice" });
  }
  release();
  // The Web transport's existing setTokens handoff fences the older SDK call.
  expect(await first).toMatchObject([sdkRefresh
    ? { status: "fulfilled", value: { user_id: "alice" } }
    : { status: "rejected", reason: { status: 401 } }]);

  const committed = set.mock.calls.map(([name, value]) => [name, value]);
  const next = new WebRuntimeClient(runtimeConfig(jar.get(ACCESS_TOKEN_COOKIE)!, jar.get(REFRESH_TOKEN_COOKIE)!));
  await expect(next.sdk.getMe()).resolves.toEqual({ user_id: "alice" });
  expect(committed).toEqual([
    [ACCESS_TOKEN_COOKIE, "access-2"],
    [REFRESH_TOKEN_COOKIE, "refresh-2"],
  ]);
  expect(jar.get(REFRESH_TOKEN_COOKIE)).toBe(validRefresh);
  expect(refreshRequests).toEqual(["refresh-0", "refresh-1"]);
});
