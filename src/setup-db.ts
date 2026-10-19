import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env first.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  console.log('Database schema is ready.');
} finally {
  await pool.end();
}
