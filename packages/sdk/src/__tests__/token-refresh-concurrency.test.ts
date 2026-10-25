import { AstraClient } from '../client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const rotated = { access_token: 'new-access', refresh_token: 'new-refresh' };
const unauthorized = () => Response.json({ detail: 'expired' }, { status: 401 });
const authorization = (init?: RequestInit) => new Headers(init?.headers).get('Authorization');

afterEach(() => vi.unstubAllGlobals());

test('REST and buffered SSE share one refresh of a single-use token', async () => {
  const refresh = deferred<Response>();
  const onTokenRefresh = vi.fn();
  let refreshCount = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) {
      refreshCount++;
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'old-refresh' });
      // The runtime revokes the token on its first successful refresh.
      return refreshCount === 1 ? refresh.promise : unauthorized();
    }
    if (authorization(init) === 'Bearer old-access') return unauthorized();
    expect(authorization(init)).toBe('Bearer new-access');
    return url.includes('/stream')
      ? new Response('data: {"type":"run_finished"}\n\n')
      : Response.json({ user_id: 'alice' });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access',
    refreshToken: 'old-refresh', onTokenRefresh,
  });
  const results = Promise.allSettled([client.getMe(), client.getRunEvents('run-1')]);
  await vi.waitFor(() => expect(refreshCount).toBeGreaterThan(0));
  refresh.resolve(Response.json(rotated));
  expect((await results).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(refreshCount).toBe(1);
  expect(onTokenRefresh).toHaveBeenCalledTimes(1);
});

test('a late 401 reuses the token already rotated by another request', async () => {
  const late = deferred<Response>();
  let initialRequests = 0;
  let refreshCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) {
      refreshCount++;
      return Response.json(rotated);
    }
    if (authorization(init) === 'Bearer old-access') {
      return ++initialRequests === 1 ? late.promise : unauthorized();
    }
    return Response.json({ user_id: 'alice' });
  }));
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access', refreshToken: 'old-refresh',
  });
  const first = client.getMe();
  await client.getMe();
  late.resolve(unauthorized());
  await expect(first).resolves.toEqual({ user_id: 'alice' });
  expect(refreshCount).toBe(1);
});

test.each(['http', 'network'] as const)('failed %s refresh is shared but a later attempt can recover', async (failure) => {
  const refresh = deferred<Response>();
  let refreshCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) {
      refreshCount++;
      if (refreshCount > 1) return Response.json(rotated);
      await refresh.promise;
      if (failure === 'network') throw new TypeError('connection lost');
      return unauthorized();
    }
    return authorization(init) === 'Bearer old-access'
      ? unauthorized() : Response.json({ user_id: 'alice' });
  }));
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access', refreshToken: 'old-refresh',
  });
  const results = Promise.allSettled([client.getMe(), client.getMe()]);
  await vi.waitFor(() => expect(refreshCount).toBeGreaterThan(0));
  refresh.resolve(unauthorized());
  expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(refreshCount).toBe(1);
  await expect(client.getMe()).resolves.toEqual({ user_id: 'alice' });
  expect(refreshCount).toBe(2);
});

test.each(['setTokens', 'login', 'register', 'logout'] as const)(
  'a refresh started before %s cannot restore the previous credentials', async (action) => {
    const refresh = deferred<Response>();
    const onTokenRefresh = vi.fn();
    let refreshCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh')) { refreshCount++; return refresh.promise; }
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/login') || url.endsWith('/auth/register')) {
        return Response.json({ access_token: 'bob-access', refresh_token: 'bob-refresh' });
      }
      return authorization(init) === 'Bearer old-access'
        ? unauthorized() : Response.json({ user_id: 'bob' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new AstraClient({
      baseUrl: 'https://example.test', accessToken: 'old-access',
      refreshToken: 'old-refresh', onTokenRefresh,
    });
    const pending = Promise.allSettled([client.getMe()]);
    await vi.waitFor(() => expect(refreshCount).toBe(1));
    if (action === 'setTokens') client.setTokens('bob-access', 'bob-refresh');
    else if (action === 'logout') await client.logout();
    else await client[action]('bob', 'password');
    const callsBeforeCompletion = fetchMock.mock.calls.length;
    refresh.resolve(Response.json(rotated));
    expect((await pending)[0].status).toBe('rejected');
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeCompletion);
    expect(onTokenRefresh).not.toHaveBeenCalled();
    await client.getMe();
    expect(authorization(fetchMock.mock.lastCall?.[1])).toBe(
      action === 'logout' ? null : 'Bearer bob-access',
    );
  },
);
