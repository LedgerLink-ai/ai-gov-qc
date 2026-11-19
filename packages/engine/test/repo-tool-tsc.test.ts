import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './helpers';
import { allowlistedRepo, cliEnv, describeBuilt, qa } from './cli-helpers';

// AIQC-91: the default pre-push type check ("qa repo-tool typescript:tsc
// --noEmit") must not fail every push in a repository whose TypeScript
// projects live in sub-folders, with no tsconfig.json at the root.

describeBuilt('qa repo-tool typescript:tsc', () => {
  let repo: ReturnType<typeof allowlistedRepo>;
  beforeEach(() => {
    repo = allowlistedRepo();
    // A stand-in for the repository's own typescript package: prints its
    // arguments and exits with FAKE_TSC_EXIT.
    const pkg = join(repo.dir, 'node_modules', 'typescript');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: 'bin/tsc' } }));
    writeFileSync(
      join(pkg, 'bin', 'tsc'),
      "console.log('tsc ran: ' + process.argv.slice(2).join(' '));\nprocess.exit(Number(process.env.FAKE_TSC_EXIT || 0));\n",
    );
  });
  afterEach(() => rmSync(repo.dir, { recursive: true, force: true }));

  const run = (args: string[], exit = '0') =>
    qa(['repo-tool', 'typescript:tsc', ...args], {
      cwd: repo.dir,
      env: cliEnv({ QA_CONFIG_DIR: CONFIG_DIR, FAKE_TSC_EXIT: exit }),
    });

  it('skips with a notice when the root has no tsconfig.json and no project is given', () => {
    const res = run(['--noEmit'], '1');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no tsconfig.json at the repository root');
    expect(res.stdout).toContain('typescript:tsc -p <path to tsconfig.json> --noEmit');
    expect(res.stdout).not.toContain('tsc ran');
  });

  it('runs tsc, and fails with it, when the root has a tsconfig.json', () => {
    writeFileSync(join(repo.dir, 'tsconfig.json'), '{}\n');
    expect(run(['--noEmit'])).toMatchObject({ status: 0, stdout: expect.stringContaining('tsc ran: --noEmit') });
    expect(run(['--noEmit'], '1').status).toBe(1);
  });

  it('runs tsc when the hook gives the project or the files', () => {
    for (const args of [
      ['-p', 'packages/a/tsconfig.json', '--noEmit'],
      ['--project', 'packages/a', '--noEmit'],
      ['-b', 'packages/a'],
      ['--noEmit', 'src/index.ts'],
    ]) {
      const res = run(args, '1');
      expect(res.status).toBe(1);
      expect(res.stdout).toContain(`tsc ran: ${args.join(' ')}`);
    }
  });
});
