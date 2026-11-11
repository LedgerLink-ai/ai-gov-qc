import { createLogger } from '../src/log';
import { redact, redactDeep, registerSecret } from '../src/redact';

// Values assembled at run time, so this file itself carries no credential-shaped literal.
const gh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join(
  '.',
);
const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA1234', '-----END RSA PRIVATE KEY-----'].join('\n');

describe('redaction', () => {
  it.each([
    ['a GitHub token', `token is ${gh} here`],
    ['an AWS access key id', `key ${aws}`],
    ['a JWT', `bearer ${jwt}`],
    ['a private key block', `before\n${pem}\nafter`],
    ['a password in a URL', 'https://deploy:hunter2secret@example.com/repo.git'],
    ['an Authorization header', 'Authorization: Bearer abcdefghijklmnop123456'],
    ['a password assignment', 'DB_PASSWORD=correct-horse-battery'],
  ])('masks %s', (_what, text) => {
    const out = redact(text, {});
    expect(out).toContain('[REDACTED]');
    for (const secret of [
      gh,
      aws,
      jwt,
      'MIIEpAIBAAKCAQEA1234',
      'hunter2secret',
      'abcdefghijklmnop123456',
      'correct-horse-battery',
    ])
      expect(out).not.toContain(secret);
  });

  it('keeps ordinary text, including what qa itself prints', () => {
    const text =
      'Possible secret (generic-api-key: Generic API Key). The value is not shown. Fix: Remove the value, rotate the credential (R22-10) and load it from the secrets manager.';
    expect(redact(text, {})).toBe(text);
  });

  it('masks the values of credential environment variables wherever they appear', () => {
    expect(redact('upload failed with s3cr3t-value-123 in the URL', { MY_SERVICE_TOKEN: 's3cr3t-value-123' })).toBe(
      'upload failed with [REDACTED] in the URL',
    );
  });

  it('masks a registered secret and redacts nested report data', () => {
    registerSecret('report-token-abcdef');
    expect(redactDeep({ a: ['x report-token-abcdef y'], b: { c: 1 } }, {})).toEqual({
      a: ['x [REDACTED] y'],
      b: { c: 1 },
    });
  });

  it('never writes a secret into a structured log line', () => {
    const lines: string[] = [];
    const log = createLogger({ format: 'json', level: 'debug' }, (l) => lines.push(l), 'run-1');
    log.error('engine.error', { error: `git failed: https://x:${gh}@github.com/o/r` });
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({ level: 'error', event: 'engine.error', run_id: 'run-1' });
    expect(record.engine_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lines[0]).not.toContain(gh);
  });
});
