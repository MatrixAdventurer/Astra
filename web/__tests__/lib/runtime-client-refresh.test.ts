// @vitest-environment node
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { cookies } from "next/headers";
import { WebRuntimeClient } from "@/lib/runtime-client/server";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/runtime-config";

afterEach(() => vi.unstubAllGlobals());

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
  const runtime = new WebRuntimeClient({
    mode: "live", source: "cookie", apiUrl: "https://example.test",
    accessToken: "old-access", refreshToken: "old-refresh",
    demoMode: false, hasAccessToken: true, hasRefreshToken: true, message: "",
  });
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
