import crypto from 'crypto';
import { Pool, type PoolClient } from 'pg';

let pool: Pool | null = null;
let postgresReady = false;
let postgresError: string | null = null;
let maskedDbTarget = 'Local Memory (Set DATABASE_URL for PostgreSQL 16)';

export function classifyDevice(userAgent?: string): string {
  const ua = (userAgent || '').trim();
  if (!ua) return 'API / CLI Client';
  if (/iPhone/i.test(ua)) return /CriOS/i.test(ua) ? 'iPhone Chrome' : 'iPhone Safari';
  if (/iPad/i.test(ua)) return 'iPad Safari';
  if (/Android/i.test(ua)) return /EdgA/i.test(ua) ? 'Android Edge' : 'Android Chrome';
  if (/Windows/i.test(ua)) {
    if (/Edg\//i.test(ua)) return 'Windows Edge';
    if (/Firefox/i.test(ua)) return 'Windows Firefox';
    return 'Windows Chrome';
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    if (/Chrome\//i.test(ua)) return 'macOS Chrome';
    return 'macOS Safari';
  }
  if (/Linux/i.test(ua)) return 'Linux Browser';
  return 'Web Client';
}

export function isMobileDevice(deviceLabel: string): boolean {
  return /iPhone|iPad|Android/i.test(deviceLabel);
}

export function hashTokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
}

function maskConnectionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const dbName = parsed.pathname.replace(/^\//, '') || 'autoauction';
    return `${parsed.hostname}:${parsed.port || '5432'}/${dbName}`;
  } catch {
    return 'PostgreSQL (configured)';
  }
}

export function isPostgresEnabled(): boolean {
  return Boolean(pool && postgresReady);
}

export function getPool(): Pool | null {
  return pool && postgresReady ? pool : null;
}

export function getDatabaseStatus() {
  return {
    storageMode: isPostgresEnabled() ? ('postgresql' as const) : ('memory' as const),
    storageLabel: isPostgresEnabled()
      ? `PostgreSQL 16 (${maskedDbTarget})`
      : 'Local Memory Fallback',
    target: maskedDbTarget,
    error: postgresError,
  };
}

export async function withPgTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<{ result: T; durationMs: number } | null> {
  const activePool = getPool();
  if (!activePool) return null;

  const started = performance.now();
  const client = await activePool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return { result, durationMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  available_balance BIGINT NOT NULL DEFAULT 0,
  escrow_balance BIGINT NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL DEFAULT 'scrypt-64B-sha256',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auctions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  year INTEGER NOT NULL,
  condition TEXT NOT NULL,
  location TEXT NOT NULL,
  seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_name TEXT NOT NULL,
  reserve_price BIGINT NOT NULL,
  end_time BIGINT NOT NULL,
  status TEXT NOT NULL,
  rejection_reason TEXT,
  specs JSONB NOT NULL DEFAULT '[]'::jsonb,
  proxy_bid JSONB,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  lot_id TEXT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id TEXT NOT NULL,
  bidder_name TEXT NOT NULL,
  amount BIGINT NOT NULL,
  is_auto_pilot BOOLEAN NOT NULL DEFAULT FALSE,
  device_label TEXT NOT NULL DEFAULT 'System',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bids_lot_created ON bids (lot_id, created_at ASC);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  lot_id TEXT,
  lot_title TEXT,
  note TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txns_created ON wallet_transactions (created_at DESC);

CREATE TABLE IF NOT EXISTS active_sessions (
  token_fingerprint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  device_label TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  device_label TEXT NOT NULL,
  lot_id TEXT,
  summary TEXT NOT NULL,
  sql_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_events_created ON device_events (created_at DESC);
`;

export async function initDatabase(): Promise<boolean> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    postgresReady = false;
    postgresError = null;
    maskedDbTarget = 'Local Memory (Set DATABASE_URL for PostgreSQL 16)';
    return false;
  }

  maskedDbTarget = maskConnectionUrl(url);
  try {
    pool = new Pool({
      connectionString: url,
      max: 15,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    await pool.query('SELECT 1');
    await pool.query(SCHEMA_SQL);
    postgresReady = true;
    postgresError = null;
    console.log(`[PostgreSQL] Connected and schema verified at ${maskedDbTarget}`);
    return true;
  } catch (err) {
    postgresReady = false;
    postgresError = err instanceof Error ? err.message : 'Unable to connect to PostgreSQL';
    console.warn(
      `[PostgreSQL] Connection failed (${postgresError}). Falling back to local in-memory store.`
    );
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
    return false;
  }
}
