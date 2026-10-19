import { randomUUID } from 'node:crypto';
import type { Finding, RepositorySnapshot, Scanner, Severity } from './domain.js';

export class DependencyScanError extends Error {}

type Advisory = {
  id: string;
  summary?: string;
  withdrawn?: string;
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ecosystem_specific?: { severity?: string } }[];
};

export class DependencyScanner implements Scanner {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async scan(repository: RepositorySnapshot, onProgress: Parameters<Scanner['scan']>[1]): Promise<Finding[]> {
    const file = repository.files.find(({ path }) => path === 'package-lock.json');
    if (!file) {
      await onProgress(84, 'Dependency check skipped: no root package-lock.json');
      return [];
    }
    let lock;
    try { lock = JSON.parse(file.content); } catch {
      throw new DependencyScanError('Dependency check failed: package-lock.json is invalid JSON.');
    }
    if (!lock || ![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
      throw new DependencyScanError('Dependency check supports package-lock.json versions 2 and 3 only.');
    }
    const packages = new Map<string, { name: string; version: string; path: string }>();
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || !entry || typeof entry !== 'object') continue;
      const item = entry as { version?: unknown; name?: unknown; link?: boolean; resolved?: unknown };
      if (item.link) continue;
      const name = typeof item.name === 'string' ? item.name : path.split('node_modules/').at(-1);
      if (!name || !path.includes('node_modules/') || typeof item.version !== 'string'
        || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(item.version)) {
        throw new DependencyScanError('Dependency check encountered an unsupported package entry in package-lock.json.');
      }
      if (typeof item.resolved === 'string' && !item.resolved.startsWith('https://registry.npmjs.org/')) {
        throw new DependencyScanError('Dependency check supports npm registry packages only.');
      }
      packages.set(`${name}@${item.version}`, { name, version: item.version, path });
    }
    if (packages.size > 100) throw new DependencyScanError('POC dependency check is limited to 100 unique package versions.');
    const findings: Finding[] = [];
    const signal = AbortSignal.timeout(30_000);
    const entries = [...packages.values()];
    await onProgress(81, `Checking ${entries.length} package versions against OSV`);
    try {
      for (let offset = 0; offset < entries.length; offset += 5) {
        const results = await Promise.all(entries.slice(offset, offset + 5).map(async (entry) => {
          const response = await this.fetcher('https://api.osv.dev/v1/query', {
            method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ package: { name: entry.name, ecosystem: 'npm' }, version: entry.version }),
          });
          if (!response.ok) throw new Error('OSV request failed');
          const data = await response.json() as { vulns?: Advisory[]; next_page_token?: string };
          if (!data || data.next_page_token || (data.vulns !== undefined && !Array.isArray(data.vulns))) throw new Error('Incomplete OSV response');
          return (data.vulns ?? []).filter((advisory) => !advisory.withdrawn).map((advisory): Finding => {
            if (!advisory.id) throw new Error('Invalid advisory');
            const affected = advisory.affected?.find(({ package: pkg }) => pkg?.name === entry.name && pkg.ecosystem === 'npm');
            const rating = (advisory.database_specific?.severity ?? affected?.ecosystem_specific?.severity ?? '').toLowerCase();
            const knownSeverity = ['critical', 'high', 'medium', 'low'].includes(rating);
            const severity: Severity = knownSeverity ? rating as Severity : 'medium';
            const key = JSON.stringify(entry.path);
            const position = file.content.indexOf(key);
            const line = position < 0 ? 1 : file.content.slice(0, position).split('\n').length;
            return {
              id: randomUUID(), ruleId: 'dependency-vulnerability', severity,
              dependency: { name: entry.name, version: entry.version },
              title: `${entry.name}@${entry.version}: ${advisory.id}`,
              description: `${advisory.summary ?? 'Known vulnerability reported by OSV.'} Locked at ${entry.path}. Advisory: https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}.${knownSeverity ? '' : ' Severity unavailable; medium is a review-priority fallback.'}`,
              recommendation: `Review advisory ${advisory.id}, upgrade ${entry.name} to a version outside its affected ranges, regenerate the lockfile and run your tests. For a transitive dependency, update the parent dependency where possible.`,
              filePath: file.path, line,
            };
          });
        }));
        findings.push(...results.flat());
        await onProgress(81 + Math.floor(Math.min(offset + 5, entries.length) / entries.length * 3), `Checked ${Math.min(offset + 5, entries.length)}/${entries.length} package versions`);
      }
    } catch {
      throw new DependencyScanError('Dependency check could not complete against OSV. Try again.');
    }
    return findings;
  }
}
