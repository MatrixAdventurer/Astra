import { AstraWebSocket } from '../websocket';

class ControlledSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: ControlledSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() { ControlledSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  close() {
    this.readyState = ControlledSocket.CLOSED;
    // Browser close events are asynchronous, unlike the older test mock.
    queueMicrotask(() => this.onclose?.());
  }
  authenticate() {
    this.readyState = ControlledSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', interaction_api_major: '3' }) });
  }
}

beforeEach(() => {
  ControlledSocket.instances = [];
  vi.stubGlobal('WebSocket', ControlledSocket);
});
afterEach(() => vi.unstubAllGlobals());

function client() {
  return new AstraWebSocket({ url: 'ws://localhost/ws', token: 'test-token', reconnect: false });
}

test('close settles connect before authentication and stale events cannot affect a new attempt', async () => {
  const ws = client();
  const outcomes: string[] = [];
  const pending = ws.connect().then(() => outcomes.push('resolved'), () => outcomes.push('rejected'));
  const oldSocket = ControlledSocket.instances[0];
  ws.close();
  await Promise.resolve();
  await Promise.resolve();
  expect(outcomes).toEqual(['rejected']);
  await pending;
  const next = ws.connect();
  oldSocket.authenticate();
  expect(ws.connectionState).toBe('connecting');
  ControlledSocket.instances[1].authenticate();
  await next;
  expect(ws.isConnected).toBe(true);
  ws.close();
});

test('concurrent connect calls share one authenticated connection', async () => {
  const ws = client();
  const callers = Array.from({ length: 100 }, () => ws.connect());
  expect(ControlledSocket.instances).toHaveLength(1);
  ControlledSocket.instances[0].authenticate();
  await Promise.all(callers);
  expect(ws.isConnected).toBe(true);
  ws.close();
});


test('a connecting listener can cancel and replace the attempt without opening a stale socket', async () => {
  const ws = client();
  let replacement: Promise<void> | undefined;
  let replaced = false;
  ws.on('stateChange', (state) => {
    if (state === 'connecting' && !replaced) {
      replaced = true;
      ws.close();
      replacement = ws.connect();
    }
  });
  const first = ws.connect();
  await expect(first).rejects.toThrow('WebSocket closed');
  expect(ControlledSocket.instances).toHaveLength(1);
  ControlledSocket.instances[0].authenticate();
  await replacement;
  expect(ws.isConnected).toBe(true);
  ws.close();
});

test.each([
  [{ type: 'auth_error', message: 'denied' }, 'denied'],
  [{ type: 'auth_ok', interaction_api_major: 'unsupported' }, 'contract mismatch'],
] as const)('authentication failure %j settles all callers and permits a fresh connection', async (frame, reason) => {
  const ws = client();
  const first = ws.connect();
  const second = ws.connect();
  ControlledSocket.instances[0].onmessage?.({ data: JSON.stringify(frame) });
  await expect(first).rejects.toThrow(reason);
  await expect(second).rejects.toThrow(reason);
  const next = ws.connect();
  ControlledSocket.instances[1].authenticate();
  await next;
  ws.close();
});

test('close settles an authenticated reconnect waiting for run attachment', async () => {
  const ws = client();
  ws.runId = 'existing-run';
  const pending = ws.connect();
  ControlledSocket.instances[0].authenticate();
  expect(ControlledSocket.instances[0].sent.map((frame) => JSON.parse(frame).type)).toEqual(['auth', 'attach_run']);
  ws.close();
  await expect(pending).rejects.toThrow('WebSocket closed');
  expect(ws.runId).toBe('existing-run');
});

test('a constructor failure clears the pending attempt so a later connect can succeed', async () => {
  const ws = client();
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('invalid URL'); } });
  await expect(ws.connect()).rejects.toThrow('invalid URL');
  expect(ws.connectionState).toBe('error');
  vi.stubGlobal('WebSocket', ControlledSocket);
  const next = ws.connect();
  ControlledSocket.instances[0].authenticate();
  await next;
  ws.close();
});

// Both notification APIs run synchronously and may call back into connect().
for (const notification of ['emitter', 'option'] as const) {
  function recoveryClient(onStateChange: (state: string) => void) {
    const ws = new AstraWebSocket({
      url: 'ws://localhost/ws', token: 'test-token', reconnect: false,
      ...(notification === 'option' ? { onStateChange } : {}),
    });
    if (notification === 'emitter') ws.on('stateChange', onStateChange);
    return ws;
  }

  test(`${notification}: error notification can synchronously start a fresh attempt`, async () => {
    let recovery: Promise<void> | undefined;
    const ws = recoveryClient((state) => {
      if (state === 'error') recovery = ws.connect();
    });
    const first = ws.connect();
    const failed = expect(first).rejects.toThrow('WebSocket connection failed');
    const old = ControlledSocket.instances[0];
    old.onerror?.();
    const recovered = recovery!.catch((error) => error);
    try {
      expect(ControlledSocket.instances).toHaveLength(2);
      expect(old.readyState).toBe(ControlledSocket.CLOSED);
      old.authenticate();
      old.onclose?.();
      expect(ws.connectionState).toBe('connecting');
      ControlledSocket.instances[1].authenticate();
      expect(await recovered).toBeUndefined();
      await failed;
      expect(ws.isConnected).toBe(true);
    } finally { ws.close(); await recovered; await failed; }
  });

  test(`${notification}: denied reattachment exposes the usable connection to synchronous connect`, async () => {
    let recovery: Promise<void> | undefined;
    let recovering = false;
    const ws = recoveryClient((state) => {
      if (recovering && state === 'connected') recovery = ws.connect();
    });
    const initial = ws.connect();
    const old = ControlledSocket.instances[0];
    old.authenticate();
    await initial;
    old.onmessage?.({ data: JSON.stringify({ type: 'run_started', run_id: 'owned-run' }) });
    old.close();
    await Promise.resolve();
    recovering = true;
    const reconnect = ws.connect();
    const denied = expect(reconnect).rejects.toThrow('Not found');
    const socket = ControlledSocket.instances[1];
    socket.authenticate();
    expect(JSON.parse(socket.sent[1])).toMatchObject({ type: 'attach_run', run_id: 'owned-run' });
    socket.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'Not found', retryable: false }) });
    const recovered = recovery!.catch((error) => error);
    try {
      await denied;
      expect(await recovered).toBeUndefined();
      expect(ControlledSocket.instances).toHaveLength(2);
      expect(ws.isConnected).toBe(true);
      expect(ws.runId).toBeNull();
    } finally { recovering = false; ws.close(); }
  });
}

test('a reattach acknowledgement listener can replace the connection without stale completion', async () => {
  const ws = client();
  const initial = ws.connect();
  const first = ControlledSocket.instances[0];
  first.authenticate();
  await initial;
  first.onmessage?.({ data: JSON.stringify({ type: 'run_started', run_id: 'owned-run' }) });
  first.close();
  await Promise.resolve();
  const reconnect = ws.connect();
  const accepted = expect(reconnect).resolves.toBeUndefined();
  const attaching = ControlledSocket.instances[1];
  attaching.authenticate();
  let replacement: Promise<void> | undefined;
  const replace = () => {
    ws.off('session_info', replace);
    ws.close();
    replacement = ws.connect();
  };
  ws.on('session_info', replace);
  attaching.onmessage?.({ data: JSON.stringify({ type: 'session_info', session_id: 'session', run_id: 'owned-run' }) });
  const replaced = replacement!.catch((error) => error);
  try {
    expect(ws.connectionState).toBe('connecting');
    await accepted;
    const current = ControlledSocket.instances[2];
    current.authenticate();
    current.onmessage?.({ data: JSON.stringify({ type: 'session_info', session_id: 'session', run_id: 'owned-run' }) });
    expect(await replaced).toBeUndefined();
    expect(ws.isConnected).toBe(true);
  } finally { ws.close(); await replaced; await accepted; }
});

test('throwing state callbacks cannot interrupt connection settlement or cleanup', async () => {
  const ws = new AstraWebSocket({
    url: 'ws://localhost/ws', token: 'test-token', reconnect: false,
    onStateChange: (state) => {
      if (state !== 'connecting') throw new Error('consumer callback failed');
    },
  });
  let outcome = 'pending';
  const connecting = Promise.resolve().then(() => ws.connect()).then(
    () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
  );
  try {
    await Promise.resolve();
    expect(ControlledSocket.instances).toHaveLength(1);
    ControlledSocket.instances[0].authenticate();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(outcome).toBe('resolved');
    await connecting;
    expect(ws.isConnected).toBe(true);
    expect(() => ws.close()).not.toThrow();
    expect(ws.readyState).toBe(ControlledSocket.CLOSED);
  } finally { try { ws.close(); } catch {} await connecting; }
});

test('throwing event callbacks cannot orphan an accepted attachment', async () => {
  const ws = new AstraWebSocket({
    url: 'ws://localhost/ws', token: 'test-token', reconnect: false,
    onEvent: () => { throw new Error('consumer callback failed'); },
  });
  const connecting = ws.connect();
  const socket = ControlledSocket.instances[0];
  socket.authenticate();
  await connecting;
  let outcome = 'pending';
  const attached = ws.attachRun('owned-run').then(
    () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
  );
  try {
    socket.onmessage?.({ data: JSON.stringify({ type: 'session_info', session_id: 'session', run_id: 'owned-run' }) });
    await Promise.resolve();
    expect(outcome).toBe('resolved');
    await attached;
    expect(ws.runId).toBe('owned-run');
    expect(ws.isConnected).toBe(true);
  } finally { ws.close(); }
});

test('close and explicit reconnect cancel the old automatic retry deadline', async () => {
  vi.useFakeTimers();
  const ws = new AstraWebSocket({
    url: 'ws://localhost/ws', token: 'test-token', reconnectDelayMs: 100,
  });
  try {
    const first = ws.connect();
    ControlledSocket.instances[0].authenticate();
    await first;
    ControlledSocket.instances[0].close();
    await Promise.resolve();
    ws.close();
    const reopened = ws.connect();
    ControlledSocket.instances[1].authenticate();
    await reopened;
    await vi.advanceTimersByTimeAsync(50);
    ControlledSocket.instances[1].close();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(ControlledSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(ControlledSocket.instances).toHaveLength(3);
    expect(ControlledSocket.instances.flatMap((socket) => socket.sent).map((frame) => JSON.parse(frame).type))
      .not.toContain('cancel_run');
  } finally { ws.close(); vi.useRealTimers(); }
});

for (const stage of ['authentication', 'reattachment', 'attachment'] as const) {
  test(`a ${stage} send failure settles its obligation and permits recovery`, async () => {
    let failSend = false;
    class FailingSocket extends ControlledSocket {
      send(value: string) {
        if (failSend) throw new Error('send failed');
        super.send(value);
      }
    }
    vi.stubGlobal('WebSocket', FailingSocket);
    const ws = client();
    try {
      let attempt = ws.connect();
      let socket = ControlledSocket.instances[0];
      if (stage !== 'authentication') {
        socket.authenticate();
        await attempt;
        if (stage === 'reattachment') {
          socket.onmessage?.({ data: JSON.stringify({ type: 'run_started', run_id: 'owned-run' }) });
          socket.close();
          await Promise.resolve();
          attempt = ws.connect();
          socket = ControlledSocket.instances[1];
        }
      }
      failSend = true;
      const failed = stage === 'attachment' ? ws.attachRun('owned-run') : attempt;
      const rejected = expect(failed).rejects.toThrow('send failed');
      if (stage !== 'attachment') socket.authenticate();
      await rejected;
      failSend = false;
      if (stage === 'attachment') {
        attempt = ws.attachRun('owned-run');
      } else {
        attempt = ws.connect();
        socket = ControlledSocket.instances.at(-1)!;
        socket.authenticate();
      }
      socket.onmessage?.({ data: JSON.stringify({ type: 'session_info', session_id: 'session', run_id: 'owned-run' }) });
      await attempt;
      expect(ws.isConnected).toBe(true);
    } finally { ws.close(); }
  });
}
