import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DependencyScanner } from '../src/dependency-scanner.js';
import { MemoryStore, repositoryFixture } from './helpers.js';
import { createApp } from '../src/app.js';
import { BasicReportBuilder } from '../src/report.js';

function snapshot(packages: Record<string, unknown>) {
  return { ...repositoryFixture, files: [{ path: 'package-lock.json', content: JSON.stringify({ lockfileVersion: 3, packages }, null, 2) }] };
}

test('dependency scanner queries exact locked versions, deduplicates and returns advisory details', async () => {
  const queries: unknown[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.osv.dev/v1/query');
    const query = JSON.parse(String(options?.body));
    queries.push(query);
    return Response.json(query.package.name === 'vulnerable' ? { vulns: [{
      id: 'GHSA-example', summary: 'Example vulnerability', database_specific: { severity: 'HIGH' },
    }] } : {});
  };
  const repository = snapshot({
    '': { name: 'app' },
    'node_modules/vulnerable': { version: '1.0.0' },
    'node_modules/parent/node_modules/vulnerable': { version: '1.0.0' },
    'node_modules/@scope/safe': { version: '2.0.0' },
  });
  const findings = await new DependencyScanner(fetcher).scan(repository, async () => {});
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0], { package: { name: 'vulnerable', ecosystem: 'npm' }, version: '1.0.0' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].filePath, 'package-lock.json');
  assert.match(repository.files[0].content.split('\n')[findings[0].line - 1], /vulnerable/);
  assert.match(findings[0].description, /https:\/\/osv.dev\/vulnerability\/GHSA-example/);
  assert.match(findings[0].recommendation!, /transitive dependency/);
});

test('no lockfile skips dependency scanning without a network request', async () => {
  const scanner = new DependencyScanner(async () => { throw new Error('Unexpected network request'); });
  const stages: string[] = [];
  assert.deepEqual(await scanner.scan(repositoryFixture, async (_percent, stage) => { stages.push(stage); }), []);
  assert.match(stages[0], /skipped/);
});

test('invalid lockfiles, excessive package counts and OSV failures fail explicitly', async () => {
  const scanner = new DependencyScanner(async () => Response.json({}, { status: 503 }));
  await assert.rejects(scanner.scan({ ...repositoryFixture, files: [{ path: 'package-lock.json', content: '{}' }] }, async () => {}), /versions 2 and 3/);
  await assert.rejects(scanner.scan(snapshot({ 'node_modules/test': { version: '1.0.0' } }), async () => {}), /could not complete against OSV/);
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }]));
  await assert.rejects(scanner.scan(snapshot(many), async () => {}), /limited to 100/);
});

test('withdrawn advisories are ignored and missing severity is disclosed', async () => {
  const scanner = new DependencyScanner(async () => Response.json({ vulns: [
    { id: 'withdrawn', withdrawn: '2020-01-01' }, { id: 'unknown-severity' },
  ] }));
  const findings = await scanner.scan(snapshot({ 'node_modules/test': { version: '1.0.0' } }), async () => {});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'medium');
  assert.match(findings[0].description, /fallback/);
});

test('completed API report retains dependency advice and states dependency coverage', async (t) => {
  const repository = snapshot({ 'node_modules/example': { version: '1.0.0' } });
  const scanner = new DependencyScanner(async () => Response.json({ vulns: [{ id: 'GHSA-example' }] }));
  const { app, orchestrator } = createApp(new MemoryStore(), scanner, new BasicReportBuilder(), {
    async read() { return repository; },
  });
  t.after(() => app.close());
  const accepted = await app.inject({ method: 'POST', url: '/scans', payload: { repositoryUrl: repository.repositoryUrl } });
  await orchestrator.drain();
  const result = await app.inject(`/scans/${accepted.json().scanId}/results`);
  assert.equal(result.statusCode, 200);
  const content = result.json().content;
  assert.equal(content.summary.total, 1);
  assert.match(content.findings[0].recommendation, /upgrade example/);
  assert.match(content.analysis, /against OSV/);
});
