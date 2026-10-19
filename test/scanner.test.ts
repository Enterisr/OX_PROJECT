import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BasicScanner } from '../src/scanner.js';
import { BasicReportBuilder } from '../src/report.js';
import { MemoryStore, repositoryFixture } from './helpers.js';
import { createApp } from '../src/app.js';

const repository = {
  ...repositoryFixture,
  files: [{ path: 'src/routes.ts', content: [
    'const client = { rejectUnauthorized: false };',
    'eval(',
    '  request.body.code',
    ');',
    'exec(`echo ${req.query.value}`);',
  ].join('\n') }],
};

test('source scan finds three real patterns with exact locations and actionable priority', async () => {
  const steps: number[] = [];
  const findings = await new BasicScanner().scan(repository, async (percent) => { steps.push(percent); });
  assert.deepEqual(findings.map(({ ruleId, line, filePath }) => ({ ruleId, line, filePath })), [
    { ruleId: 'tls-verification', line: 1, filePath: 'src/routes.ts' },
    { ruleId: 'dynamic-eval', line: 2, filePath: 'src/routes.ts' },
    { ruleId: 'request-shell', line: 5, filePath: 'src/routes.ts' },
  ]);
  assert.deepEqual(steps, [60, 80]);
  const scan = await new MemoryStore().create(repository.repositoryUrl);
  const report = await new BasicReportBuilder().build(scan, findings);
  assert.deepEqual(report.summary, { total: 3, bySeverity: { critical: 0, high: 2, medium: 1, low: 0 } });
  assert.deepEqual(report.findings.map(({ severity }) => severity), ['high', 'high', 'medium']);
  assert.ok(report.findings.every(({ recommendation }) => recommendation && recommendation.length > 20));
  assert.match(report.analysis!, /src\/routes.ts:2 first/);
  assert.equal(findings[0].ruleId, 'tls-verification', 'analysis must not reorder raw findings');
});

test('safe code, comments, strings and excluded files do not produce findings', async () => {
  const content = [
    '// eval(req.body.code);',
    'const example = "eval(request.body.code)";',
    'execFile("echo", [req.query.value]);',
    'exec("echo fixed");',
    'const options = { rejectUnauthorized: true };',
  ].join('\n');
  const findings = await new BasicScanner().scan({ ...repositoryFixture, files: [
    { path: 'src/safe.ts', content },
    { path: 'README.md', content: 'eval(req.body.code)' },
    { path: 'node_modules/library/index.js', content: 'eval(req.body.code)' },
  ] }, async () => {});
  assert.deepEqual(findings, []);
  const scan = await new MemoryStore().create(repositoryFixture.repositoryUrl);
  const report = await new BasicReportBuilder().build(scan, findings);
  assert.equal(report.summary.total, 0);
  assert.match(report.analysis!, /No matching patterns/);
  assert.match(report.analysis!, /does not establish/);
});

test('real scanner findings and analysis are returned through the completed scan API', async (t) => {
  const { app, orchestrator } = createApp(new MemoryStore(), new BasicScanner(), new BasicReportBuilder(), {
    async read() { return repository; },
  });
  t.after(() => app.close());
  const accepted = await app.inject({ method: 'POST', url: '/scans', payload: { repositoryUrl: repository.repositoryUrl } });
  assert.equal(accepted.statusCode, 202);
  await orchestrator.drain();
  const result = await app.inject(`/scans/${accepted.json().scanId}/results`);
  assert.equal(result.statusCode, 200);
  const report = result.json();
  assert.equal(report.engine, 'basic-rules-v1');
  assert.equal(report.content.summary.total, 3);
  assert.ok(report.content.findings.every((finding: { recommendation?: string }) => finding.recommendation));
  assert.match(report.content.analysis, /manual verification/);
  assert.equal(report.content.repository.commitSha, repository.commitSha);
});
