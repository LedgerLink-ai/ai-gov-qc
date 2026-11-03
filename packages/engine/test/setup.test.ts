import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies } from '../src/cli';
import { expectedChecksum, gitleaksAsset, pyLauncherVersions } from '../src/setup';
import { CONFIG_DIR } from './helpers';

describe('qa setup: choosing a Python on Windows', () => {
  it('lists the launcher versions newest first, in both launcher formats', () => {
    expect(
      pyLauncherVersions(' -V:3.15 *        Python 3.15 (64-bit)\n -V:3.12          Python 3.12 (64-bit)\n'),
    ).toEqual(['-3.15', '-3.12']);
    expect(pyLauncherVersions(' -3.11-64 *\n -3.9-32\n')).toEqual(['-3.11', '-3.9']);
    expect(pyLauncherVersions('No installed Pythons found!')).toEqual([]);
  });
});

describe('qa --require', () => {
  it('accepts the same or a newer compatible version', () => {
    expect(satisfies('0.1.0', '0.1.0')).toBe(true);
    expect(satisfies('0.1.3', '0.1.0')).toBe(true);
    expect(satisfies('1.4.0', '1.2.5')).toBe(true);
  });

  it('rejects older versions and other major versions (other minors below 1.0)', () => {
    expect(satisfies('0.1.0', '0.1.1')).toBe(false);
    expect(satisfies('0.2.0', '0.1.0')).toBe(false);
    expect(satisfies('2.0.0', '1.0.0')).toBe(false);
    expect(satisfies('1.1.0', '1.2.0')).toBe(false);
    expect(satisfies('1.0', '1.0.0')).toBe(false);
  });
});

describe('qa setup: gitleaks download', () => {
  it('picks the release asset for each operating system and CPU', () => {
    expect(gitleaksAsset('8.30.1', 'win32', 'x64')).toBe('gitleaks_8.30.1_windows_x64.zip');
    expect(gitleaksAsset('8.30.1', 'darwin', 'arm64')).toBe('gitleaks_8.30.1_darwin_arm64.tar.gz');
    expect(gitleaksAsset('8.30.1', 'linux', 'x64')).toBe('gitleaks_8.30.1_linux_x64.tar.gz');
    expect(gitleaksAsset('8.30.1', 'aix', 'ppc64')).toBeUndefined();
  });

  it('has a published checksum for every asset it can pick', () => {
    const sums = readFileSync(join(CONFIG_DIR, 'config', 'gitleaks_8.30.1_checksums.txt'), 'utf8');
    for (const [platform, arch] of [
      ['win32', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
    ]) {
      const asset = gitleaksAsset('8.30.1', platform as NodeJS.Platform, arch as NodeJS.Architecture);
      expect(expectedChecksum(sums, asset as string)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(expectedChecksum(sums, 'gitleaks_8.30.1_plan9_x64.tar.gz')).toBeUndefined();
  });
});
