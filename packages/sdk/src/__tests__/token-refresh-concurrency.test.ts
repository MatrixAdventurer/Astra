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

test('an async notification can receive 401 without blocking its callers or later recovery', async () => {
  const refreshTokens: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) {
      refreshTokens.push(JSON.parse(String(init?.body)).refresh_token);
      if (refreshTokens.length === 2) return Response.json({}, { status: 503 });
      return Response.json(refreshTokens.length === 1 ? rotated
        : { access_token: 'recovered-access', refresh_token: 'recovered-refresh' });
    }
    return authorization(init) === 'Bearer recovered-access'
      ? Response.json({ user_id: 'alice' }) : unauthorized();
  }));
  const onTokenRefresh = vi.fn(async () => { await client.getMe(); });
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access',
    refreshToken: 'old-refresh', onTokenRefresh,
  });
  const results = await Promise.allSettled([client.getMe(), client.getRunEvents('run-1')]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(refreshTokens).toEqual(['old-refresh', 'new-refresh']);
  expect(onTokenRefresh).toHaveBeenCalledTimes(1);
  await expect(client.getMe()).resolves.toEqual({ user_id: 'alice' });
  expect(refreshTokens).toEqual(['old-refresh', 'new-refresh', 'new-refresh']);
  expect(onTokenRefresh).toHaveBeenCalledTimes(2);
});

test('a successful nested refresh still permits only one replay of the buffered SSE request', async () => {
  const refreshTokens: string[] = [];
  const callbackResults: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) {
      refreshTokens.push(JSON.parse(String(init?.body)).refresh_token);
      return Response.json(refreshTokens.length === 1 ? rotated
        : { access_token: 'recovered-access', refresh_token: 'recovered-refresh' });
    }
    return url.endsWith('/auth/me') && authorization(init) === 'Bearer recovered-access'
      ? Response.json({ user_id: 'alice' }) : unauthorized();
  });
  vi.stubGlobal('fetch', fetchMock);
  const onTokenRefresh = vi.fn(async () => { callbackResults.push(await client.getMe()); });
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access',
    refreshToken: 'old-refresh', onTokenRefresh,
  });
  await expect(client.getRunEvents('run-1')).rejects.toMatchObject({ status: 401 });
  expect(refreshTokens).toEqual(['old-refresh', 'new-refresh']);
  expect(callbackResults).toEqual([{ user_id: 'alice' }, { user_id: 'alice' }]);
  expect(onTokenRefresh).toHaveBeenCalledTimes(2);
  const streamRequests = fetchMock.mock.calls.filter(([url]) => url.includes('/stream'));
  expect(streamRequests.map(([, init]) => authorization(init))).toEqual([
    'Bearer old-access', 'Bearer recovered-access',
  ]);
  expect(streamRequests.every(([, init]) => new Headers(init?.headers).get('Accept') === 'text/event-stream')).toBe(true);
});

test('already joined callers await an async notification that successfully reenters the client', async () => {
  const notification = deferred<void>();
  const entered = deferred<void>();
  const settled = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) return Response.json(rotated);
    if (authorization(init) === 'Bearer old-access') return unauthorized();
    return url.includes('/stream') ? new Response('data: {"type":"run_finished"}\n\n')
      : Response.json({ user_id: 'alice' });
  }));
  const onTokenRefresh = vi.fn(async () => {
    await client.getMe();
    entered.resolve();
    await notification.promise;
  });
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access',
    refreshToken: 'old-refresh', onTokenRefresh,
  });
  const results = Promise.allSettled([client.getMe(), client.getRunEvents('run-1')]
    .map(request => request.then(settled, settled)));
  await entered.promise;
  expect(settled).not.toHaveBeenCalled();
  notification.resolve();
  await results;
  expect(settled).toHaveBeenCalledTimes(2);
  expect(settled).toHaveBeenCalledWith({ user_id: 'alice' });
  expect(settled).toHaveBeenCalledWith([{ type: 'run_finished' }]);
  expect(onTokenRefresh).toHaveBeenCalledTimes(1);
});

test.each(['throw', 'reject'] as const)('a notification %s settles joined callers and preserves rotated credentials', async failure => {
  const refresh = deferred<Response>();
  const refreshTokens: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) {
      refreshTokens.push(JSON.parse(String(init?.body)).refresh_token);
      return refreshTokens.length === 1 ? refresh.promise
        : Response.json({ access_token: 'recovered-access', refresh_token: 'recovered-refresh' });
    }
    return authorization(init) === 'Bearer recovered-access'
      ? Response.json({ user_id: 'alice' }) : unauthorized();
  }));
  const onTokenRefresh = vi.fn(() => {
    if (onTokenRefresh.mock.calls.length > 1) return;
    const error = new Error('notification failed');
    if (failure === 'throw') throw error;
    return Promise.reject(error);
  });
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access',
    refreshToken: 'old-refresh', onTokenRefresh,
  });
  const results = Promise.allSettled([client.getMe(), client.getRunEvents('run-1')]);
  await vi.waitFor(() => expect(refreshTokens).toHaveLength(1));
  refresh.resolve(Response.json(rotated));
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
  await expect(client.getMe()).resolves.toEqual({ user_id: 'alice' });
  expect(refreshTokens).toEqual(['old-refresh', 'new-refresh']);
  expect(onTokenRefresh).toHaveBeenCalledTimes(2);
});

test('an older notification cannot replay across accounts or release a newer refresh', async () => {
  const notification = deferred<void>();
  const notified = deferred<void>();
  const bobRefresh = deferred<Response>();
  const bobRefreshing = deferred<void>();
  const refreshTokens: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/refresh')) {
      const token = JSON.parse(String(init?.body)).refresh_token;
      refreshTokens.push(token);
      if (token === 'old-refresh') return Response.json(rotated);
      bobRefreshing.resolve();
      return bobRefresh.promise;
    }
    return authorization(init) === 'Bearer bob-access'
      ? Response.json({ user_id: 'bob' }) : unauthorized();
  }));
  const onTokenRefresh = vi.fn(async ({ accessToken }: { accessToken: string }) => {
    if (accessToken !== 'new-access') return;
    notified.resolve();
    await notification.promise;
  });
  const client = new AstraClient({
    baseUrl: 'https://example.test', accessToken: 'old-access',
    refreshToken: 'old-refresh', onTokenRefresh,
  });
  const alice = Promise.allSettled([client.getMe()]);
  await notified.promise;
  client.setTokens('bob-expired', 'bob-refresh');
  const firstBob = client.getMe();
  await bobRefreshing.promise;
  notification.resolve();
  expect((await alice)[0].status).toBe('rejected');
  const secondBob = client.getMe();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(refreshTokens).toEqual(['old-refresh', 'bob-refresh']);
  bobRefresh.resolve(Response.json({ access_token: 'bob-access', refresh_token: 'bob-new-refresh' }));
  expect(await Promise.all([firstBob, secondBob])).toEqual([{ user_id: 'bob' }, { user_id: 'bob' }]);
  expect(onTokenRefresh).toHaveBeenCalledTimes(2);
});
