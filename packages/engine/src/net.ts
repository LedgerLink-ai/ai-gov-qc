/**
 * Network access, used only by "qa setup" (Gitleaks download) and central
 * reporting: HTTPS only (plain HTTP only to this machine), a time limit per
 * attempt, and retries with backoff for failures that a retry can fix
 * (network errors, timeouts, 429 and 5xx). Never retried: other 4xx.
 */

export interface RetryOptions {
  /** Milliseconds for one attempt. */
  timeoutMs: number;
  /** Extra attempts after the first. */
  retries: number;
  /** First backoff in milliseconds; doubles each retry. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} from ${safeUrl(url)}`);
    this.name = 'HttpError';
  }
}

/** The URL without credentials, query or fragment, for messages. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `url`, or an Error when it is not https (or http to this machine) or carries credentials. */
export function assertSafeUrl(url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (u.username || u.password) throw new Error(`${what} must not contain a user name or password`);
  if (u.protocol === 'https:') return url;
  if (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)) return url;
  throw new Error(`${what} must use https:// (got ${u.protocol}//${u.host})`);
}

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** fetch with a time limit per attempt and retries; throws HttpError or the last network error. */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: Error = new Error('no attempt made');
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep((opts.backoffMs ?? 1000) * 2 ** (attempt - 1));
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'follow' });
      if (res.ok) return res;
      lastError = new HttpError(res.status, url);
      if (!retryable(res.status)) throw lastError;
    } catch (err) {
      if (err instanceof HttpError && !retryable(err.status)) throw err;
      lastError =
        (err as Error).name === 'TimeoutError'
          ? new Error(`no answer from ${safeUrl(url)} within ${Math.round(opts.timeoutMs / 1000)} s`)
          : (err as Error);
    }
  }
  throw lastError;
}
