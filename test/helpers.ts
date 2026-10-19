import { randomUUID } from 'node:crypto';
import type { Finding, Report, ReportContent, RepositoryReader, RepositorySnapshot, Scan, ScanStatus, ScanStore } from '../src/domain.js';

export const repositoryFixture: RepositorySnapshot = {
  repositoryUrl: 'https://github.com/owner/repo', defaultBranch: 'main', commitSha: 'a'.repeat(40),
  files: [{ path: 'package.json', content: '{"name":"test-repo"}' }], skippedFileCount: 0,
};

export const fixtureReader: RepositoryReader = {
  async read(repositoryUrl) { return { ...repositoryFixture, repositoryUrl }; },
};

export class MemoryStore implements ScanStore {
  scans = new Map<string, Scan>();
  reports = new Map<string, Report>();

  async create(repositoryUrl: string) {
    const scan: Scan = {
      id: randomUUID(), repositoryUrl, createdAt: new Date().toISOString(),
      status: 'queued', progress: 0, stage: 'Queued', error: null,
    };
    this.scans.set(scan.id, scan);
    return { ...scan };
  }

  async get(id: string) { return this.scans.get(id); }

  async update(id: string, status: ScanStatus, progress: number, stage: string, error?: string) {
    Object.assign(this.scans.get(id)!, { status, progress, stage, error: error ?? null });
  }

  async complete(scanId: string, _findings: Finding[], engine: string, content: ReportContent) {
    this.reports.set(scanId, { id: randomUUID(), scanId, engine, content, createdAt: new Date().toISOString() });
    await this.update(scanId, 'completed', 100, 'Completed');
  }

  async getReport(id: string) { return this.reports.get(id); }
}
