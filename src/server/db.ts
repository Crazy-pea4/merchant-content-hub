import { transcriptFingerprint, legacyTranscriptFingerprint } from './transcript-fingerprint';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { seedRecords } from './seed';
import type { TranscriptionJob } from './transcription-queue';
import type { AsrJob } from './asr';
import type { StoredVoice, StoredDubbing, StoredDubbingSource } from './dubbing';
import type { StoredNarration, StoredNarrationRender } from './narration';
import type { StudioSession } from '../shared/studio';
import type { StoredDouyinExtraction } from './douyin';
import type { Merchant, Project, Asset, Content, ShotTask, Activity } from '../shared/types';

export const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true });
export interface Records { merchants: Merchant; projects: Project; assets: Asset; contents: Content; tasks: ShotTask; activities: Activity; asr_jobs: AsrJob; transcription_jobs: TranscriptionJob; voices: StoredVoice; dubbings: StoredDubbing; dubbing_sources: StoredDubbingSource; narrations: StoredNarration; narration_renders: StoredNarrationRender; douyin_extractions: StoredDouyinExtraction; studio_sessions: StudioSession }
export type Table = keyof Records;
export const tables: Table[] = ['merchants', 'projects', 'assets', 'contents', 'tasks', 'activities', 'asr_jobs', 'transcription_jobs', 'voices', 'dubbings', 'dubbing_sources', 'narrations', 'narration_renders', 'douyin_extractions', 'studio_sessions'];
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const databaseDriver = process.env.DB_DRIVER === 'sqlite' ? 'sqlite' : 'postgres';
if (databaseDriver === 'postgres' && !process.env.DATABASE_URL) throw new Error('请配置 PostgreSQL DATABASE_URL；隔离演示可显式使用 DB_DRIVER=sqlite');
const pool = databaseDriver === 'postgres' ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 10000 }) : null;
const sqlite = databaseDriver === 'sqlite' ? new DatabaseSync(resolve(dataDir, 'hub.sqlite')) : null;
pool?.on('error', () => { console.error('PostgreSQL connection interrupted'); });
const context = new AsyncLocalStorage<PoolClient | true>();
let tail = Promise.resolve();
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; });
  await previous; try { return await work(); } finally { release(); }
}
function tableName(table: Table) { if (!tables.includes(table)) throw new Error('不支持的数据表'); return table; }
async function rawQuery<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
  if (pool) {
    const client = context.getStore(); const result = await (client && client !== true ? client : pool).query<T>(sql, values);
    return { rows: result.rows || [], rowCount: result.rowCount || 0 };
  }
  const run = async () => {
    const statement = sqlite!.prepare(sql.replace(/\$\d+/g, '?'));
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) {
      const rows = statement.all(...values as any[]).map(row => ({ ...row, ...(typeof row.data === 'string' ? { data: JSON.parse(row.data) } : {}) })) as T[];
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...values as any[]); return { rows: [] as T[], rowCount: Number(result.changes) };
  };
  return context.getStore() ? run() : exclusive(run);
}
async function atomic<T>(work: () => T | Promise<T>): Promise<T> {
  if (context.getStore()) return work();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Preserve the original short write-transaction semantics across API/worker processes.
      await client.query('SELECT pg_advisory_xact_lock(18433201)');
      const result = await context.run(client, work); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return exclusive(async () => {
    sqlite!.exec('BEGIN IMMEDIATE');
    try { const result = await context.run(true, work); sqlite!.exec('COMMIT'); return result; }
    catch (error) { sqlite!.exec('ROLLBACK'); throw error; }
  });
}
async function rawPut<T extends Table>(table: T, record: Records[T]): Promise<Records[T]> {
  tableName(table); const payload = JSON.stringify(record);
  if (table === 'transcription_jobs') {
    const j = record as TranscriptionJob;
    await rawQuery('INSERT INTO transcription_jobs(id,project_id,status,run_at,lease_until,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,status=excluded.status,run_at=excluded.run_at,lease_until=excluded.lease_until,data=excluded.data', [j.id, j.projectId, j.status, j.runAt, j.leaseUntil, payload]);
  } else if (['merchants', 'voices', 'dubbings', 'dubbing_sources', 'narrations', 'narration_renders', 'douyin_extractions', 'studio_sessions'].includes(table)) await rawQuery(`INSERT INTO ${table}(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, [record.id, payload]);
  else if (table === 'projects') await rawQuery('INSERT INTO projects(id,merchant_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET merchant_id=excluded.merchant_id,data=excluded.data', [record.id, (record as Project).merchantId, payload]);
  else await rawQuery(`INSERT INTO ${table}(id,project_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,data=excluded.data`, [record.id, (record as Asset).projectId, payload]);
  return record;
}
async function initialize() {
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hub_schema(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS hub_migrations(name TEXT PRIMARY KEY, data JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS merchants(id TEXT PRIMARY KEY, ordinal BIGSERIAL UNIQUE, data JSONB NOT NULL CHECK(data->>'id'=id));
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, ordinal BIGSERIAL UNIQUE, merchant_id TEXT NOT NULL REFERENCES merchants(id), data JSONB NOT NULL CHECK(data->>'id'=id AND data->>'merchantId'=merchant_id));
      ${['assets','contents','tasks','activities'].map(t => `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY, ordinal BIGSERIAL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), data JSONB NOT NULL CHECK(data->>'id'=id AND data->>'projectId'=project_id));`).join('\n')}
      ${['voices','dubbings','dubbing_sources','narrations','narration_renders','douyin_extractions', 'studio_sessions'].map(t => `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY, ordinal BIGSERIAL UNIQUE, data JSONB NOT NULL CHECK(data->>'id'=id));`).join('\n')}
      CREATE TABLE IF NOT EXISTS asr_jobs(id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, ordinal BIGSERIAL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), data JSONB NOT NULL CHECK(data->>'id'=id AND data->>'projectId'=project_id));
      CREATE TABLE IF NOT EXISTS transcription_jobs(id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE, ordinal BIGSERIAL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), status TEXT NOT NULL, run_at BIGINT NOT NULL, lease_until BIGINT NOT NULL, data JSONB NOT NULL CHECK(data->>'id'=id AND data->>'projectId'=project_id));
      CREATE INDEX IF NOT EXISTS transcription_due ON transcription_jobs(status,run_at,lease_until);
      ${['assets','contents','tasks','activities','asr_jobs','transcription_jobs'].map(t => `CREATE INDEX IF NOT EXISTS ${t}_project ON ${t}(project_id);`).join('\n')}
      INSERT INTO hub_schema(version) VALUES(1),(2),(3) ON CONFLICT DO NOTHING;
    `);
  } else {
    sqlite!.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS merchants(id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL REFERENCES merchants(id),data TEXT NOT NULL CHECK(json_valid(data)));
      ${['assets','contents','tasks','activities'].map(t => `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL CHECK(json_valid(data)));`).join('\n')}
      ${['voices','dubbings','dubbing_sources','narrations','narration_renders','douyin_extractions', 'studio_sessions'].map(t => `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data)));`).join('\n')}
      CREATE TABLE IF NOT EXISTS asr_jobs(id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS transcription_jobs(id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id),status TEXT NOT NULL,run_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX IF NOT EXISTS transcription_due ON transcription_jobs(status,run_at,lease_until); PRAGMA user_version=5;`);
  }
  await atomic(async () => {
    let migrated = false;
    const legacyPath = process.env.LEGACY_SQLITE_PATH;
    if (pool && legacyPath && existsSync(legacyPath)) {
      const previous = await rawQuery('SELECT name FROM hub_migrations WHERE name=$1', ['sqlite-v3-import']);
      if (!previous.rows.length) {
        for (const table of tables) if ((await rawQuery(`SELECT id FROM ${table} LIMIT 1`)).rows.length) throw new Error('PostgreSQL 已有业务数据，拒绝自动合并 SQLite；请核对迁移目标');
        const source = new DatabaseSync(resolve(legacyPath), { readOnly: true });
        try {
          source.exec('BEGIN'); const counts: Record<string, number> = {};
          const assetMap = new Map((source.prepare('SELECT data FROM assets').all()).map(row => { const a=JSON.parse(String(row.data)) as Asset;return [a.id,a]; }));
          for (const table of tables) {
            if (['voices', 'dubbings', 'dubbing_sources', 'narrations', 'narration_renders', 'douyin_extractions', 'studio_sessions'].includes(table) && !source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) { counts[table] = 0; continue; }
            const rows = source.prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`).all(); counts[table] = rows.length;
            for (const row of rows) {
              const record=JSON.parse(String(row.data));
              if (['asr_jobs','transcription_jobs'].includes(table)) { const a=assetMap.get(record.id); if (a && record.fingerprint===legacyTranscriptFingerprint(a)) record.fingerprint=transcriptFingerprint(a); }
              await rawPut(table, record);
            }
          }
          source.exec('COMMIT');
          await rawQuery('INSERT INTO hub_migrations(name,data) VALUES($1,$2)', ['sqlite-v3-import', JSON.stringify({ importedAt: now(), counts })]);
          migrated = true; console.log('SQLite business data imported into PostgreSQL', JSON.stringify(counts));
        } finally { source.close(); }
      } else migrated = true;
    }
    if (!migrated && process.env.SEED_DEMO !== 'false' && !(await rawQuery('SELECT id FROM merchants LIMIT 1')).rows.length) {
      for (const entry of seedRecords(id, now)) await rawPut(entry.table, entry.record);
    }
  });
}
export const databaseReady = initialize();
export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) { await databaseReady; return rawQuery<T>(sql, values); }
export async function all<T extends Table>(table: T): Promise<Records[T][]> { tableName(table); const result = await query<{ data: Records[T] }>(`SELECT data FROM ${table} ORDER BY ${pool ? 'ordinal' : 'rowid'} DESC`); return result.rows.map(row => row.data); }
export async function get<T extends Table>(table: T, key: string): Promise<Records[T] | undefined> { tableName(table); const result = await query<{ data: Records[T] }>(`SELECT data FROM ${table} WHERE id=$1`, [key]); return result.rows[0]?.data; }
export async function put<T extends Table>(table: T, record: Records[T]) { await databaseReady; return rawPut(table, record); }
export async function remove(table: Table, key: string) { tableName(table); await query(`DELETE FROM ${table} WHERE id=$1`, [key]); }
export async function transaction<T>(work: () => T | Promise<T>) { await databaseReady; return atomic(work); }
export async function log(projectId: string, text: string) { await put('activities', { id: id(), projectId, text, at: now() }); }
export const db = { query, async close() { await databaseReady; if (pool) await pool.end(); else sqlite!.close(); } };
