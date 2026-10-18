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
  const first = ws.connect();
  const second = ws.connect();
  expect(ControlledSocket.instances).toHaveLength(1);
  ControlledSocket.instances[0].authenticate();
  await Promise.all([first, second]);
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

test('authentication failure settles all callers and permits a fresh connection', async () => {
  const ws = client();
  const first = ws.connect();
  const second = ws.connect();
  ControlledSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'auth_error', message: 'denied' }) });
  await expect(first).rejects.toThrow('denied');
  await expect(second).rejects.toThrow('denied');
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

for (const callback of ['emitter', 'legacy'] as const) {
  test(`${callback}: an error callback can start a replacement connection`, async () => {
    let recovery: Promise<void> | undefined;
    const recover = (state: string) => {
      if (state === 'error') recovery = ws.connect();
    };
    const ws = new AstraWebSocket({
      url: 'ws://localhost/ws', token: 'test-token', reconnect: false,
      ...(callback === 'legacy' ? { onStateChange: recover } : {}),
    });
    if (callback === 'emitter') ws.on('stateChange', recover);
    const first = ws.connect();
    const rejected = expect(first).rejects.toThrow('WebSocket connection failed');
    ControlledSocket.instances[0].onerror?.();
    await rejected;
    expect(ControlledSocket.instances).toHaveLength(2);
    expect(recovery).toBeDefined();
    ControlledSocket.instances[1].authenticate();
    await recovery;
    expect(ws.isConnected).toBe(true);
    ws.close();
  });

  test(`${callback}: a denied reattach callback can use the authenticated connection`, async () => {
    let recovering = false;
    let recovery: Promise<void> | undefined;
    const recover = (state: string) => {
      if (recovering && state === 'connected') recovery = ws.connect();
    };
    const ws = new AstraWebSocket({
      url: 'ws://localhost/ws', token: 'test-token', reconnect: false,
      ...(callback === 'legacy' ? { onStateChange: recover } : {}),
    });
    if (callback === 'emitter') ws.on('stateChange', recover);
    const first = ws.connect();
    ControlledSocket.instances[0].authenticate();
    await first;
    ControlledSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'run_started', run_id: 'missing-run' }) });
    ws.close();
    recovering = true;
    const next = ws.connect();
    const rejected = expect(next).rejects.toThrow('Not found');
    const socket = ControlledSocket.instances[1];
    socket.authenticate();
    expect(JSON.parse(socket.sent[1])).toMatchObject({ type: 'attach_run', run_id: 'missing-run' });
    socket.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'Not found', retryable: false }) });
    await rejected;
    expect(recovery).toBeDefined();
    await expect(recovery).resolves.toBeUndefined();
    expect(ws.isConnected).toBe(true);
    expect(ws.runId).toBeNull();
    expect(ControlledSocket.instances).toHaveLength(2);
    ws.close();
  });
}
