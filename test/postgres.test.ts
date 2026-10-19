import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { PostgresScanStore } from '../src/store.js';
import { BasicReportBuilder } from '../src/report.js';
import type { Finding } from '../src/domain.js';
import { repositoryFixture } from './helpers.js';

test('PostgreSQL persists reports, rolls back failures, and marks interrupted scans', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run the PostgreSQL integration test.',
}, async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    const store = new PostgresScanStore(pool);
    const scan = await store.create('https://github.com/owner/repo');
    assert.equal((await store.get(scan.id))?.status, 'queued');
    const findings: Finding[] = [{ id: randomUUID(), severity: 'high', title: 'Demo', description: 'Synthetic', filePath: 'demo/file.ts', line: 1 }];
    const builder = new BasicReportBuilder();
    const content = {
      ...(await builder.build(scan, findings, repositoryFixture)),
      repository: {
        commitSha: repositoryFixture.commitSha,
        defaultBranch: repositoryFixture.defaultBranch,
        textFileCount: repositoryFixture.files.length,
        skippedFileCount: repositoryFixture.skippedFileCount,
      },
    };
    await store.complete(scan.id, findings, builder.engine, content);
    const secondStore = new PostgresScanStore(pool);
    assert.equal((await secondStore.get(scan.id))?.status, 'completed');
    assert.deepEqual((await secondStore.getReport(scan.id))?.content, content);
    assert.equal(Number((await pool.query('SELECT count(*) FROM findings WHERE scan_id = $1', [scan.id])).rows[0].count), 1);

    const failed = await store.create('https://github.com/owner/failure');
    const freshFinding = { ...findings[0], id: randomUUID() };
    await assert.rejects(store.complete(failed.id, [freshFinding, findings[0]], builder.engine, content));
    assert.equal((await store.get(failed.id))?.status, 'queued');
    assert.equal(await store.getReport(failed.id), undefined);
    assert.equal(Number((await pool.query('SELECT count(*) FROM findings WHERE scan_id = $1', [failed.id])).rows[0].count), 0);

    await store.update(failed.id, 'running', 40, 'Scanning');
    await store.failInterruptedScans();
    assert.equal((await store.get(failed.id))?.status, 'failed');
    assert.equal((await store.get(scan.id))?.status, 'completed');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
