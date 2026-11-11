import { fetchWithRetry, assertSafeUrl, safeUrl } from './net';
import { registerSecret } from './redact';
import { toEvidence } from './report';
import type { RunResult } from './types';

/**
 * Central reporting: sends the run's evidence (engine version, profiles, check
 * statuses, failed validations, summary; never file contents or secret
 * values) to a collector, e.g. the organisation's evidence store or a log
 * pipeline.
 *
 *   QA_REPORT_URL        https endpoint that accepts a JSON POST (--report-url)
 *   QA_REPORT_TOKEN      sent as "Authorization: Bearer <token>"; never logged
 *   QA_REPORT_REQUIRED=1 a failed upload is an engine error (exit 2); otherwise a warning
 *
 * In GitHub Actions the reusable workflow also uploads SARIF to code scanning
 * and evidence.json as an artifact, so reporting works without a collector.
 */

export interface PublishOptions {
  url: string;
  token?: string;
  timeoutMs: number;
  retries: number;
  runId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function publishEvidence(result: RunResult, opts: PublishOptions): Promise<void> {
  const url = assertSafeUrl(opts.url, 'the report URL');
  registerSecret(opts.token);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': `ledgerlink-qa/${result.engineVersion}`,
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  try {
    await fetchWithRetry(
      url,
      { method: 'POST', headers, body: JSON.stringify(toEvidence(result, { runId: opts.runId })) },
      { timeoutMs: opts.timeoutMs, retries: opts.retries, fetchImpl: opts.fetchImpl, sleep: opts.sleep },
    );
  } catch (err) {
    throw new Error(`could not send the report to ${safeUrl(url)}: ${(err as Error).message}`);
  }
}
