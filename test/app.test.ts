import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { normalizeRepositoryUrl } from '../src/repository-url.js';
import type { Scanner } from '../src/domain.js';
import { BasicReportBuilder } from '../src/report.js';
import { BasicScanner, MockScanner } from '../src/scanner.js';
import { fixtureReader, MemoryStore, repositoryFixture } from './helpers.js';
import { RepositoryReadError } from '../src/github-handler.js';

test('the scan API validates and forwards an optional full commit SHA', async (t) => {
  const store = new MemoryStore();
  const requested: (string | undefined)[] = [];
  const { app, orchestrator } = createApp(store, new BasicScanner(), new BasicReportBuilder(), {
    async read(repositoryUrl, _progress, commitSha) {
      requested.push(commitSha);
      return { ...repositoryFixture, repositoryUrl, commitSha: commitSha ?? repositoryFixture.commitSha };
    },
  });
  t.after(() => app.close());
  for (const commitSha of ['', 'main', 'abc123', 'g'.repeat(40), null, 123]) {
    const response = await app.inject({ method: 'POST', url: '/scans', payload: { repositoryUrl: repositoryFixture.repositoryUrl, commitSha } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(store.scans.size, 0);
  for (const commitSha of ['B'.repeat(40), undefined]) {
    const response = await app.inject({ method: 'POST', url: '/scans', payload: { repositoryUrl: repositoryFixture.repositoryUrl, ...(commitSha === undefined ? {} : { commitSha }) } });
    assert.equal(response.statusCode, 202);
    await orchestrator.drain();
    const result = await app.inject(`/scans/${response.json().scanId}/results`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().content.repository.commitSha, commitSha?.toLowerCase() ?? repositoryFixture.commitSha);
  }
  assert.deepEqual(requested, ['b'.repeat(40), undefined]);
});

test('repository input accepts only a repository URL without credentials or extra paths', () => {
  assert.equal(normalizeRepositoryUrl('https://github.com/owner/repo.git/'), 'https://github.com/owner/repo');
  for (const url of [
    'http://github.com/owner/repo', 'https://example.com/owner/repo',
    'https://github.com@evil.example/owner/repo', 'https://user:secret@github.com/owner/repo',
    'https://github.com/owner/repo/tree/main', 'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#file', 'https://github.com/owner/.git',
  ]) assert.equal(normalizeRepositoryUrl(url), undefined, url);
});

test('a scan returns 202 before scanner completion, exposes progress, then returns its report', async (t) => {
  const store = new MemoryStore();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  const scanner: Scanner = { async scan(repository, progress) {
    assert.deepEqual(repository.files, repositoryFixture.files);
    await progress(40, 'Testing scan');
    started();
    await waiting;
    return [];
  } };
  const { app, orchestrator } = createApp(store, scanner, new BasicReportBuilder(), fixtureReader);
  t.after(async () => { release(); await app.close(); });

  const response = await app.inject({ method: 'POST', url: '/scans', payload: { repositoryUrl: 'https://github.com/owner/repo' } });
  assert.equal(response.statusCode, 202);
  const id = response.json().scanId;
  assert.equal(response.headers.location, `/scans/${id}`);
  await running;
  const progress = await app.inject(`/scans/${id}`);
  assert.equal(progress.json().status, 'running');
  assert.equal(progress.json().progress, 40);
  assert.equal((await app.inject(`/scans/${id}/results`)).statusCode, 409);

  release();
  await orchestrator.drain();
  assert.equal((await app.inject(`/scans/${id}`)).json().status, 'completed');
  const result = await app.inject(`/scans/${id}/results`);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().content.summary.total, 0);
  assert.equal(result.json().engine, 'basic-rules-v1');
  assert.equal(result.json().content.repository.commitSha, repositoryFixture.commitSha);
  assert.equal(result.json().content.repository.textFileCount, 1);
});

test('scanner failure is persisted without exposing internal error details', async (t) => {
  const store = new MemoryStore();
  const scanner: Scanner = { async scan() { throw new Error('private connection detail'); } };
  const { app, orchestrator } = createApp(store, scanner, new BasicReportBuilder(), fixtureReader);
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/scans', payload: { repositoryUrl: 'https://github.com/owner/repo' } });
  await orchestrator.drain();
  const id = response.json().scanId;
  const scan = (await app.inject(`/scans/${id}`)).json();
  assert.equal(scan.status, 'failed');
  assert.equal(scan.error, 'Scan could not be completed.');
  assert.equal(store.reports.size, 0);
  assert.equal((await app.inject(`/scans/${id}/results`)).statusCode, 409);
});

test('invalid requests and missing scans do not create jobs', async (t) => {
  const store = new MemoryStore();
  const { app } = createApp(store, new BasicScanner(), new BasicReportBuilder(), fixtureReader);
  t.after(() => app.close());
  for (const payload of [{}, { repositoryUrl: 'https://example.com/repo' }, { repositoryUrl: 'https://github.com/o/r', ref: 'main' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/scans', payload })).statusCode, 400);
  }
  assert.equal((await app.inject('/scans/invalid')).statusCode, 400);
  assert.equal((await app.inject(`/scans/${randomUUID()}`)).statusCode, 404);
  assert.equal((await app.inject(`/scans/${randomUUID()}/results`)).statusCode, 404);
  assert.equal(store.scans.size, 0);
});

test('mock scanner and report builder produce labeled fixtures and correct counts', async () => {
  const store = new MemoryStore();
  const scan = await store.create('https://github.com/owner/repo');
  const steps: number[] = [];
  const findings = await new MockScanner().scan(repositoryFixture, async (percent) => { steps.push(percent); });
  const content = await new BasicReportBuilder().build(scan, findings);
  assert.deepEqual(steps, [65, 75]);
  assert.deepEqual(content.summary, { total: 3, bySeverity: { critical: 0, high: 1, medium: 1, low: 1 } });
  assert.ok(findings.every((finding) => finding.title.startsWith('Demo:') && finding.filePath.startsWith('demo/')));
});

test('the web entry and assets are served, while unknown paths stay 404', async (t) => {
  const { app } = createApp(new MemoryStore(), new BasicScanner(), new BasicReportBuilder(), fixtureReader);
  t.after(() => app.close());
  const page = await app.inject('/?scan=example');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Basic source scan/);
  assert.equal((await app.inject('/app.js')).statusCode, 200);
  assert.equal((await app.inject('/styles.css')).statusCode, 200);
  assert.equal((await app.inject('/unknown')).statusCode, 404);
});

test('repository rejection stops the scanner and persists the public-only error', async (t) => {
  let scannerCalled = false;
  const scanner: Scanner = { async scan() { scannerCalled = true; return []; } };
  const { app, orchestrator } = createApp(new MemoryStore(), scanner, new BasicReportBuilder(), {
    async read() { throw new RepositoryReadError('Repository not found or not public.'); },
  });
  t.after(() => app.close());
  const accepted = await app.inject({ method: 'POST', url: '/scans', payload: { repositoryUrl: 'https://github.com/owner/private' } });
  await orchestrator.drain();
  const status = (await app.inject(`/scans/${accepted.json().scanId}`)).json();
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'Repository not found or not public.');
  assert.equal(scannerCalled, false);
});

