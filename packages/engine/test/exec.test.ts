import { envMs, isCredentialName, runProcess, scrubbedEnv } from '../src/exec';

describe('running external programs', () => {
  it('stops a program that runs past its time limit, and says so', async () => {
    const started = Date.now();
    const res = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('returns the exit status and output of a program that finishes', async () => {
    const res = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok"); process.exit(3)'], {
      timeoutMs: 20_000,
    });
    expect(res).toMatchObject({ status: 3, stdout: 'ok', timedOut: false });
  });

  it('reports a program that does not exist instead of throwing', async () => {
    const res = await runProcess('qa-test-no-such-program', [], { timeoutMs: 5000 });
    expect(res.error).toBeDefined();
    expect(res.status).toBeNull();
  });

  it('passes arguments literally, never through a shell (no command injection)', async () => {
    const payload = '$(echo pwned) `echo pwned` ; echo pwned & echo pwned | echo %PATH%';
    const res = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload], {
      timeoutMs: 20_000,
    });
    expect(res.stdout).toBe(payload);
  });
});

describe('credentials in the environment', () => {
  it('recognises credential variable names', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'NPM_TOKEN',
      'SEMGREP_APP_TOKEN',
      'DB_PASSWORD',
      'OPENAI_API_KEY',
      'QA_REPORT_TOKEN',
      'GH_PAT',
    ])
      expect(isCredentialName(name)).toBe(true);
    for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'QA_HOME', 'SSH_AUTH_SOCK'])
      expect(isCredentialName(name)).toBe(false);
  });

  it('removes them from the environment a scanner gets', () => {
    const env = scrubbedEnv({ PATH: '/bin', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'k', HOME: '/h' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('a child process started with the scrubbed environment cannot read a token', async () => {
    const res = await runProcess(process.execPath, ['-e', 'process.stdout.write(String(process.env.GITHUB_TOKEN))'], {
      env: scrubbedEnv({ ...process.env, GITHUB_TOKEN: 'ghp_shouldnotleak' }),
      timeoutMs: 20_000,
    });
    expect(res.stdout).toBe('undefined');
  });
});

describe('time limits from the environment', () => {
  it('reads whole milliseconds and refuses anything else', () => {
    expect(envMs('X', { X: '1500' })).toBe(1500);
    expect(envMs('X', {})).toBeUndefined();
    expect(() => envMs('X', { X: '-1' })).toThrow(/whole number/);
    expect(() => envMs('X', { X: '1.5' })).toThrow(/whole number/);
  });
});
