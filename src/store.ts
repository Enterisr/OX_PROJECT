import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Finding, Report, ReportContent, Scan, ScanStatus, ScanStore } from './domain.js';

const scanColumns = `id, repository_url AS "repositoryUrl", created_at AS "createdAt", status, progress, stage, error`;

function scanFromRow(row: Scan & { createdAt: Date }): Scan {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export class PostgresScanStore implements ScanStore {
  constructor(private readonly pool: Pool) {}

  async create(repositoryUrl: string): Promise<Scan> {
    const result = await this.pool.query(
      `INSERT INTO scans (id, repository_url, status) VALUES ($1, $2, 'queued') RETURNING ${scanColumns}`,
      [randomUUID(), repositoryUrl],
    );
    return scanFromRow(result.rows[0]);
  }

  async get(id: string): Promise<Scan | undefined> {
    const result = await this.pool.query(`SELECT ${scanColumns} FROM scans WHERE id = $1`, [id]);
    return result.rows[0] ? scanFromRow(result.rows[0]) : undefined;
  }

  async update(id: string, status: ScanStatus, progress: number, stage: string, error?: string) {
    await this.pool.query(
      'UPDATE scans SET status = $2, progress = $3, stage = $4, error = $5 WHERE id = $1',
      [id, status, progress, stage, error ?? null],
    );
  }

  async complete(scanId: string, findings: Finding[], engine: string, content: ReportContent) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const finding of findings) {
        await client.query('INSERT INTO findings (id, scan_id, content) VALUES ($1, $2, $3)', [finding.id, scanId, finding]);
      }
      await client.query('INSERT INTO reports (id, scan_id, engine, content) VALUES ($1, $2, $3, $4)',
        [randomUUID(), scanId, engine, content]);
      await client.query("UPDATE scans SET status = 'completed', progress = 100, stage = 'Completed', error = NULL WHERE id = $1", [scanId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getReport(scanId: string): Promise<Report | undefined> {
    const result = await this.pool.query(
      `SELECT id, scan_id AS "scanId", created_at AS "createdAt", engine, content
       FROM reports WHERE scan_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [scanId],
    );
    const row = result.rows[0];
    return row ? { ...row, createdAt: row.createdAt.toISOString() } : undefined;
  }

  async failInterruptedScans() {
    await this.pool.query(
      `UPDATE scans SET status = 'failed', stage = 'Interrupted', error = 'Server restarted before the scan completed.'
       WHERE status IN ('queued', 'running')`,
    );
  }
}
