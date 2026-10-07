import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

export class SqlHarness {
  readonly schema = 'phase22_test_' + randomUUID().replace(/-/g, '');
  private admin?: Pool;
  pool!: Pool;
  scopedUrl!: string;

  async open(): Promise<void> {
    const raw = process.env.PHASE22_TEST_DATABASE_URL;
    if (!raw) throw new Error('PHASE22_TEST_DATABASE_URL is required; SQL proof never skips');
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const approvedNeon = url.hostname === 'ep-crimson-grass-azmsfir8-pooler.c-3.ap-southeast-1.aws.neon.tech';
    if ((!loopback && !approvedNeon) || (!loopback && !url.hostname.endsWith('.neon.tech'))) {
      throw new Error('Phase22 database is not an approved TEST server');
    }
    const expectedDatabase = loopback ? 'congdongngonngu_phase22_ci' : 'neondb';
    if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase || url.searchParams.has('options')) {
      throw new Error('Phase22 TEST database identity/options mismatch');
    }
    // Neon transaction pooling rejects startup search_path options. Derive only
    // the direct endpoint of the exact approved TEST instance, then verify it.
    if (approvedNeon) url.hostname = 'ep-crimson-grass-azmsfir8.c-3.ap-southeast-1.aws.neon.tech';
    this.admin = new Pool({ connectionString: url.toString(), max: 2 });
    const result = await this.admin.query('SELECT current_database() AS db, current_schema() AS schema, current_setting(\'server_version_num\')::int AS version');
    if (result.rows[0].db !== expectedDatabase || result.rows[0].schema !== 'public' || result.rows[0].version < 180000) {
      throw new Error('Phase22 TEST database/schema/PostgreSQL18 guard failed');
    }
    if (!/^phase22_test_[a-f0-9]{32}$/.test(this.schema)) throw new Error('Unsafe isolated schema');
    await this.admin.query('CREATE SCHEMA "' + this.schema + '"');
    url.searchParams.set('options', '-c search_path=' + this.schema + ',public');
    this.scopedUrl = url.toString();
    this.pool = new Pool({ connectionString: this.scopedUrl, max: 24, application_name: 'phase22-sql-proof' });
    if ((await this.pool.query('SELECT current_schema() AS schema')).rows[0].schema !== this.schema) {
      throw new Error('Isolated schema was not selected');
    }
    await this.migration('0001_identity.sql');
    await this.migration('0027_phase22_study_groups.sql');
  }

  async migration(filename: string): Promise<void> {
    const sql = await readFile(path.resolve(__dirname, '../../database/migrations', filename), 'utf8');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async reset(): Promise<void> {
    await this.pool.query('TRUNCATE study_groups, study_group_rate_limits, users CASCADE');
  }

  async invalidCommit(sql: string, values: unknown[], code: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let failure: unknown;
      try { await client.query(sql, values); await client.query('COMMIT'); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ code });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    if (this.admin) {
      try {
        if (!/^phase22_test_[a-f0-9]{32}$/.test(this.schema)) throw new Error('Unsafe cleanup schema');
        await this.admin.query('DROP SCHEMA IF EXISTS "' + this.schema + '" CASCADE');
        const remaining = await this.admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [this.schema]);
        expect(remaining.rowCount).toBe(0);
      } finally { await this.admin.end(); }
    }
  }
}
