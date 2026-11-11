import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchWithRetry, HttpError } from '../src/net';
import { publishEvidence } from '../src/publish';
import { run } from '../src/runner';
import { options } from './helpers';

const noSleep = async (): Promise<void> => undefined;

function fakeFetch(statuses: Array<number | 'network'>): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  const fetchImpl = (async () => {
    const s = statuses[Math.min(n++, statuses.length - 1)];
    if (s === 'network') throw new TypeError('fetch failed');
    return new Response('x', { status: s });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => n };
}

describe('retries', () => {
  it('retries network errors and 5xx, then succeeds', async () => {
    const f = fakeFetch(['network', 503, 200]);
    const res = await fetchWithRetry(
      'https://example.invalid/x',
      {},
      { timeoutMs: 1000, retries: 3, ...f, sleep: noSleep },
    );
    expect(res.status).toBe(200);
    expect(f.calls()).toBe(3);
  });

  it('does not retry a client error', async () => {
    const f = fakeFetch([404, 200]);
    await expect(
      fetchWithRetry('https://example.invalid/x', {}, { timeoutMs: 1000, retries: 3, ...f, sleep: noSleep }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(f.calls()).toBe(1);
  });

  it('gives up after the configured retries with the last error', async () => {
    const f = fakeFetch([500]);
    await expect(
      fetchWithRetry('https://example.invalid/x', {}, { timeoutMs: 1000, retries: 2, ...f, sleep: noSleep }),
    ).rejects.toThrow(/HTTP 500/);
    expect(f.calls()).toBe(3);
  });
});

describe('central reporting', () => {
  let server: Server;
  let url: string;
  const received: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  let failFirst = 0;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (failFirst > 0) {
          failFirst--;
          res.writeHead(503).end();
          return;
        }
        received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/evidence`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sends the evidence with the token, retrying a busy collector', async () => {
    failFirst = 1;
    const result = await run(options({ 'AGENTS.md': 'Call qa​ first.\n' }));
    await publishEvidence(result, {
      url,
      token: 'tok-123456789',
      timeoutMs: 5000,
      retries: 2,
      runId: 'r-9',
      sleep: noSleep,
    });
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe('Bearer tok-123456789');
    expect(received[0].body).toMatchObject({
      schema: 'ledgerlink-qa/evidence/v1',
      run_id: 'r-9',
      exit_code: 1,
      failed_validations: [expect.objectContaining({ check: 'ai-config.content-lint', path: 'AGENTS.md' })],
    });
    // Evidence carries no file contents.
    expect(JSON.stringify(received[0].body)).not.toContain('Call qa');
  });

  it('refuses a plain-http endpoint that is not this machine, and names no credentials when it fails', async () => {
    const result = await run(options({ 'src/a.ts': 'x' }));
    await expect(
      publishEvidence(result, { url: 'http://collector.example.com/e', timeoutMs: 1000, retries: 0 }),
    ).rejects.toThrow(/https/);
    await expect(
      publishEvidence(result, {
        url: 'https://127.0.0.1:1/e?token=abc',
        token: 'secret-token-xyz',
        timeoutMs: 500,
        retries: 0,
      }),
    ).rejects.toThrow(/^could not send the report to https:\/\/127\.0\.0\.1:1\/e: /);
  });
});
