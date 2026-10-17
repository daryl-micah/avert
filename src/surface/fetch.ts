import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Ecosystem = 'npm' | 'pypi';

const CACHE = () => process.env.AVERT_CACHE ?? join(homedir(), '.cache', 'avert');

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function json(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

/** Latest published version of a package. */
export async function latest(eco: Ecosystem, pkg: string): Promise<string> {
  if (eco === 'npm') return (await json(`https://registry.npmjs.org/${pkg}/latest`)).version;
  return (await json(`https://pypi.org/pypi/${pkg}/json`)).info.version;
}

/** All published versions, oldest first (registry order). */
export async function versions(eco: Ecosystem, pkg: string): Promise<{ version: string; date?: string }[]> {
  if (eco === 'npm') {
    const doc = await json(`https://registry.npmjs.org/${pkg}`);
    return Object.keys(doc.versions).map((v) => ({ version: v, date: doc.time?.[v] }));
  }
  const doc = await json(`https://pypi.org/pypi/${pkg}/json`);
  return Object.entries(doc.releases as Record<string, any[]>).map(([v, files]) => ({ version: v, date: files[0]?.upload_time_iso_8601 }));
}

/**
 * Download and unpack one published package version into its own cache directory.
 * The contents are only parsed, never executed or imported.
 */
export async function fetchPackage(eco: Ecosystem, pkg: string, version: string): Promise<string> {
  const dir = join(CACHE(), 'sdk', eco, `${pkg.replace('/', '__')}@${version}`);
  if (existsSync(join(dir, '.done'))) return join(dir, 'package');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (eco === 'npm') {
    const meta = await json(`https://registry.npmjs.org/${pkg}/${version}`);
    writeFileSync(join(dir, 'pkg.tgz'), await download(meta.dist.tarball));
    execFileSync('tar', ['-xzf', 'pkg.tgz', '--no-same-owner'], { cwd: dir });
  } else {
    const meta = await json(`https://pypi.org/pypi/${pkg}/${version}/json`);
    const wheel = (meta.urls as any[]).find((u) => u.packagetype === 'bdist_wheel');
    if (!wheel) throw new Error(`${pkg}@${version}: no wheel on PyPI`);
    writeFileSync(join(dir, 'pkg.whl'), await download(wheel.url));
    execFileSync('unzip', ['-q', '-o', 'pkg.whl', '-d', 'package'], { cwd: dir });
  }
  writeFileSync(join(dir, '.done'), '');
  return join(dir, 'package');
}
