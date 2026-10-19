import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { DependencyScanner } from '../../src/dependency-scanner.js';
import type { Finding, Report, RepositorySnapshot, Scan } from '../../src/domain.js';
import { PublicGitHubReader } from '../../src/github-handler.js';
import { BasicReportBuilder } from '../../src/report.js';
import { BasicScanner } from '../../src/scanner.js';
import { PostgresScanStore } from '../../src/store.js';

test('live GitHub repository completes the HTTP happy flow with real scanners, BasicReportBuilder and PostgreSQL', {
  timeout: 120_000,
}, async (t) => {
  const repositoryUrl = 'https://github.com/luin/serialize';
  const commitSha = 'f9051f4104a3cd873f29b8815796e9f5d065c1a9';
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for the live integration test.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000,
  });
  const store = new PostgresScanStore(pool);
  let scannedRepository: RepositorySnapshot | undefined;
  let scannedFindings: Finding[] | undefined;
  const reports = new BasicReportBuilder();
  const { app } = createApp(store, {
    async scan(repository, progress) {
      scannedRepository = repository;
      scannedFindings = [
        ...await new BasicScanner().scan(repository, progress),
        ...await new DependencyScanner().scan(repository, progress),
      ];
      return scannedFindings;
    },
  }, reports, new PublicGitHubReader());
  t.after(async () => {
    try { await app.close(); }
    finally { await pool.end(); }
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const signal = AbortSignal.timeout(105_000);
  const submitted = await fetch(`${baseUrl}/scans`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositoryUrl, commitSha }),
  });
  assert.equal(submitted.status, 202);
  const { scanId } = await submitted.json() as { scanId: string };
  assert.match(scanId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(submitted.headers.get('location'), `/scans/${scanId}`);

  let scan: Scan;
  do {
    const status = await fetch(`${baseUrl}/scans/${scanId}`, { signal });
    assert.equal(status.status, 200);
    scan = await status.json() as Scan;
    assert.equal(scan.id, scanId);
    assert.equal(scan.repositoryUrl, repositoryUrl);
    assert.notEqual(scan.status, 'failed', scan.error ?? 'Scan failed');
    if (scan.status !== 'completed') {
      assert.ok(['queued', 'running'].includes(scan.status));
      assert.ok(scan.progress >= 0 && scan.progress < 100);
      await setTimeout(100, undefined, { signal });
    }
  } while (scan.status !== 'completed');

  assert.equal(scan.progress, 100);
  assert.equal(scan.error, null);
  assert.ok(scannedRepository);
  assert.ok(scannedFindings);
  const result = await fetch(`${baseUrl}/scans/${scanId}/results`, { signal });
  assert.equal(result.status, 200);
  const report = await result.json() as Report;
  assert.equal(report.scanId, scanId);
  assert.equal(report.engine, reports.engine);
  assert.ok(report.id);
  assert.ok(Number.isFinite(Date.parse(report.createdAt)));
  assert.equal(scannedRepository.repositoryUrl, repositoryUrl);
  assert.equal(scannedRepository.commitSha, commitSha);
  assert.equal(report.content.repository.commitSha, commitSha);
  assert.equal(scannedRepository.files.length, 8);
  assert.equal(scannedRepository.files.some(file => file.path === 'package-lock.json'), false);
  assert.deepEqual(
    scannedFindings.map(({ ruleId, severity, filePath, line }) => ({ ruleId, severity, filePath, line })),
    [{ ruleId: 'dynamic-eval', severity: 'high', filePath: 'lib/serialize.js', line: 76 }],
  );
  assert.deepEqual(report.content.summary, {
    total: 1, bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
  });
  assert.equal(report.content.findings.length, scannedFindings.length);
  for (const finding of report.content.findings) {
    const original: Finding | undefined = scannedFindings.find(item => item.id === finding.id);
    assert.ok(original);
    const { recommendation, ...rawFinding } = finding;
    const { recommendation: originalRecommendation, ...rawOriginal }: Finding = original;
    assert.deepEqual(rawFinding, rawOriginal);
    assert.ok(recommendation?.trim());
    if (originalRecommendation) assert.equal(recommendation, originalRecommendation);
    const file = scannedRepository.files.find(file => file.path === finding.filePath);
    assert.ok(file, `Finding refers to a downloaded file: ${finding.filePath}`);
    assert.ok(finding.line >= 1 && finding.line <= file.content.split('\n').length);
  }
  const priority = { critical: 0, high: 1, medium: 2, low: 3 };
  const severities = report.content.findings.map(finding => priority[finding.severity]);
  assert.deepEqual(severities, [...severities].sort((a, b) => a - b));
  assert.ok(report.content.actionGroups?.length);
  assert.deepEqual(
    report.content.actionGroups.flatMap(group => {
      assert.ok(group.recommendation.trim());
      return group.findingIds;
    }).sort(),
    scannedFindings.map(finding => finding.id).sort(),
  );
  assert.equal(report.content.summary.total, scannedFindings.length);
  assert.equal(Object.values(report.content.summary.bySeverity).reduce((a, b) => a + b, 0), scannedFindings.length);
  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    assert.equal(report.content.summary.bySeverity[severity], scannedFindings.filter(finding => finding.severity === severity).length);
  }
  assert.deepEqual(report.content.repository, {
    commitSha: scannedRepository.commitSha,
    defaultBranch: scannedRepository.defaultBranch,
    textFileCount: scannedRepository.files.length,
    skippedFileCount: scannedRepository.skippedFileCount,
  });
  assert.ok(report.content.analysis?.includes(`${report.content.findings[0].filePath}:${report.content.findings[0].line}`));
  const persistedStore = new PostgresScanStore(pool);
  assert.deepEqual(report, await persistedStore.getReport(scanId));
  assert.deepEqual(scan, await persistedStore.get(scanId));
  const persistedFindings = await pool.query<{ content: Finding }>(
    'SELECT content FROM findings WHERE scan_id = $1', [scanId],
  );
  assert.deepEqual(
    persistedFindings.rows.map(row => row.content).sort((a, b) => a.id.localeCompare(b.id)),
    [...scannedFindings].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const repeated = await fetch(`${baseUrl}/scans/${scanId}/results`, { signal });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), report);
  t.diagnostic(`Scanned ${repositoryUrl} at ${scannedRepository.commitSha}: ${scannedRepository.files.length} text files, ${scannedFindings.length} findings.`);
  t.diagnostic(`Saved scan ${scanId} and report ${report.id} in PostgreSQL.`);
});
