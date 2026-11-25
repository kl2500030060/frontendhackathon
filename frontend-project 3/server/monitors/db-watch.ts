import '../env.ts';
import { Pool } from 'pg';

const PORT = Number(process.env.PORT) || 3000;
const MONITOR_URL = `http://127.0.0.1:${PORT}/api/internal/monitor`;
const ONCE_MODE = process.argv.includes('--once');
const REFRESH_MS = 1500;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
};

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clean = value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
  return align === 'right' ? clean.padStart(width, ' ') : clean.padEnd(width, ' ');
}

function fmtINR(amount: number): string {
  const n = Math.round(Number(amount) || 0);
  return `₹${n.toLocaleString('en-IN')}`;
}

function fmtTime(ts: number): string {
  return new Date(Number(ts) || Date.now()).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

interface DbSnapshot {
  engineLabel: string;
  queryMs: number;
  counts: {
    users: number;
    auctions: number;
    liveAuctions: number;
    bids: number;
    transactions: number;
    sessions: number;
    events: number;
  };
  topLots: Array<{
    id: string;
    title: string;
    status: string;
    bidCount: number;
    currentPrice: number;
    leader: string;
    device: string;
  }>;
  latestBids: Array<{
    time: string;
    lotId: string;
    bidder: string;
    amount: number;
    device: string;
    isAuto: boolean;
  }>;
  escrowUsers: Array<{
    username: string;
    role: string;
    available: number;
    escrow: number;
  }>;
}

let pgPool: Pool | null = null;
if (process.env.DATABASE_URL?.trim()) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL.trim(),
    max: 4,
    connectionTimeoutMillis: 3000,
  });
}

async function fetchFromPostgres(): Promise<DbSnapshot | null> {
  if (!pgPool) return null;
  const started = performance.now();
  try {
    const [countsRes, topLotsRes, latestBidsRes, usersRes] = await Promise.all([
      pgPool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS users,
          (SELECT COUNT(*)::int FROM auctions) AS auctions,
          (SELECT COUNT(*)::int FROM auctions WHERE status = 'live') AS live_auctions,
          (SELECT COUNT(*)::int FROM bids) AS bids,
          (SELECT COUNT(*)::int FROM wallet_transactions) AS txns,
          (SELECT COUNT(*)::int FROM active_sessions) AS sessions,
          (SELECT COUNT(*)::int FROM device_events) AS events
      `),
      pgPool.query(`
        SELECT
          a.id,
          a.title,
          a.status,
          a.reserve_price,
          COALESCE(b_stats.bid_count, 0)::int AS bid_count,
          COALESCE(b_top.amount, a.reserve_price) AS current_price,
          COALESCE(b_top.bidder_name, 'Opening Reserve') AS leader,
          COALESCE(b_top.device_label, 'System') AS device,
          COALESCE(b_top.created_at, a.created_at) AS last_bid_at
        FROM auctions a
        LEFT JOIN (
          SELECT lot_id, COUNT(*) AS bid_count
          FROM bids
          WHERE bidder_id <> 'system'
          GROUP BY lot_id
        ) b_stats ON b_stats.lot_id = a.id
        LEFT JOIN LATERAL (
          SELECT amount, bidder_name, device_label, created_at
          FROM bids
          WHERE lot_id = a.id
          ORDER BY created_at DESC
          LIMIT 1
        ) b_top ON TRUE
        WHERE a.status = 'live'
        ORDER BY last_bid_at DESC
        LIMIT 8
      `),
      pgPool.query(`
        SELECT created_at, lot_id, bidder_name, amount, device_label, is_auto_pilot
        FROM bids
        WHERE bidder_id <> 'system'
        ORDER BY created_at DESC
        LIMIT 7
      `),
      pgPool.query(`
        SELECT username, role, available_balance, escrow_balance
        FROM users
        ORDER BY escrow_balance DESC, available_balance DESC
        LIMIT 8
      `),
    ]);

    const c = countsRes.rows[0];
    return {
      engineLabel: 'PostgreSQL 16 (Direct SQL Pool)',
      queryMs: Math.round((performance.now() - started) * 10) / 10,
      counts: {
        users: Number(c.users),
        auctions: Number(c.auctions),
        liveAuctions: Number(c.live_auctions),
        bids: Number(c.bids),
        transactions: Number(c.txns),
        sessions: Number(c.sessions),
        events: Number(c.events),
      },
      topLots: topLotsRes.rows.map((r) => ({
        id: String(r.id),
        title: String(r.title),
        status: String(r.status),
        bidCount: Number(r.bid_count),
        currentPrice: Number(r.current_price),
        leader: String(r.leader),
        device: String(r.device),
      })),
      latestBids: latestBidsRes.rows.map((r) => ({
        time: fmtTime(Number(r.created_at)),
        lotId: String(r.lot_id),
        bidder: String(r.bidder_name),
        amount: Number(r.amount),
        device: String(r.device_label || 'Web Client'),
        isAuto: Boolean(r.is_auto_pilot),
      })),
      escrowUsers: usersRes.rows.map((r) => ({
        username: String(r.username),
        role: String(r.role),
        available: Number(r.available_balance),
        escrow: Number(r.escrow_balance),
      })),
    };
  } catch {
    return null;
  }
}

async function fetchFromLoopback(): Promise<DbSnapshot> {
  const started = performance.now();
  const res = await fetch(MONITOR_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${MONITOR_URL}`);
  }
  const data = (await res.json()) as {
    database: { storageLabel: string };
    activeSessions: unknown[];
    securityRows: Array<{
      username: string;
      role: string;
      availableBalance: number;
      escrowBalance: number;
    }>;
    recentEvents: unknown[];
    auctions: Array<{
      id: string;
      title: string;
      status: string;
      reservePrice: number;
      createdAt: number;
      bids: Array<{
        bidderId: string;
        bidderName: string;
        amount: number;
        timestamp: number;
        deviceLabel?: string;
        isAutoPilot?: boolean;
      }>;
    }>;
    transactions: unknown[];
  };

  const allBids = data.auctions.flatMap((lot) =>
    lot.bids
      .filter((b) => b.bidderId !== 'system')
      .map((b) => ({ ...b, lotId: lot.id }))
  );

  const liveLots = data.auctions
    .filter((a) => a.status === 'live')
    .map((lot) => {
      const top = lot.bids[lot.bids.length - 1];
      return {
        id: lot.id,
        title: lot.title,
        status: lot.status,
        bidCount: lot.bids.filter((b) => b.bidderId !== 'system').length,
        currentPrice: top?.amount ?? lot.reservePrice,
        leader: top?.bidderName ?? 'Opening Reserve',
        device: top?.deviceLabel || 'System',
        lastAt: top?.timestamp ?? lot.createdAt,
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 8);

  const latestBids = [...allBids]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 7)
    .map((b) => ({
      time: fmtTime(b.timestamp),
      lotId: b.lotId,
      bidder: b.bidderName,
      amount: b.amount,
      device: b.deviceLabel || 'Web Client',
      isAuto: Boolean(b.isAutoPilot),
    }));

  const escrowUsers = [...data.securityRows]
    .sort((a, b) => b.escrowBalance - a.escrowBalance || b.availableBalance - a.availableBalance)
    .slice(0, 8)
    .map((u) => ({
      username: u.username,
      role: u.role,
      available: u.availableBalance,
      escrow: u.escrowBalance,
    }));

  return {
    engineLabel: `${data.database.storageLabel} (Loopback API)`,
    queryMs: Math.round((performance.now() - started) * 10) / 10,
    counts: {
      users: data.securityRows.length,
      auctions: data.auctions.length,
      liveAuctions: data.auctions.filter((a) => a.status === 'live').length,
      bids: allBids.length,
      transactions: data.transactions.length,
      sessions: data.activeSessions.length,
      events: data.recentEvents.length,
    },
    topLots: liveLots,
    latestBids,
    escrowUsers,
  };
}

function render(snap: DbSnapshot) {
  if (!ONCE_MODE) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
  const line = '─'.repeat(98);
  const nowStr = fmtTime(Date.now());

  console.log(
    `${C.bold}${C.cyan}╔${'═'.repeat(96)}╗${C.reset}`
  );
  console.log(
    `${C.bold}${C.cyan}║${C.reset} ${C.bold}AUTOAUC-DB :: LIVE DATABASE & ESCROW MONITOR${C.reset}  ${C.dim}|${C.reset} ${C.green}${pad(snap.engineLabel, 33)}${C.reset} ${C.dim}|${C.reset} ${C.yellow}${nowStr}${C.reset} ${C.bold}${C.cyan}║${C.reset}`
  );
  console.log(
    `${C.bold}${C.cyan}╚${'═'.repeat(96)}╝${C.reset}`
  );

  console.log(
    ` ${C.bold}TABLE COUNTS${C.reset}  ` +
      `users:${C.cyan}${snap.counts.users}${C.reset}  ` +
      `auctions:${C.cyan}${snap.counts.auctions}${C.reset} (${C.green}${snap.counts.liveAuctions} live${C.reset})  ` +
      `bids:${C.yellow}${snap.counts.bids}${C.reset}  ` +
      `txns:${C.cyan}${snap.counts.transactions}${C.reset}  ` +
      `sessions:${C.magenta}${snap.counts.sessions}${C.reset}  ` +
      `query:${C.green}${snap.queryMs}ms${C.reset}`
  );
  console.log(`${C.dim}${line}${C.reset}`);

  console.log(`${C.bold}${C.white} [1] MOST ACTIVE LIVE AUCTION LOTS (SQL ORDER BY LATEST BID)${C.reset}`);
  console.log(
    `${C.dim} ${pad('LOT ID', 10)} ${pad('ASSET TITLE', 32)} ${pad('BIDS', 5, 'right')} ${pad('HIGHEST (INR)', 16, 'right')} ${pad('LEADER', 15)} ${pad('SOURCE DEVICE', 14)}${C.reset}`
  );
  for (const lot of snap.topLots) {
    console.log(
      ` ${C.cyan}${pad(lot.id, 10)}${C.reset} ${pad(lot.title, 32)} ${C.yellow}${pad(String(lot.bidCount), 5, 'right')}${C.reset} ${C.green}${pad(fmtINR(lot.currentPrice), 16, 'right')}${C.reset} ${pad(lot.leader, 15)} ${C.magenta}${pad(lot.device, 14)}${C.reset}`
    );
  }

  console.log(`${C.dim}${line}${C.reset}`);
  console.log(`${C.bold}${C.white} [2] LATEST COMMITTED BIDS (bids TABLE)${C.reset}`);
  console.log(
    `${C.dim} ${pad('TIME', 10)} ${pad('LOT ID', 10)} ${pad('BIDDER', 18)} ${pad('AMOUNT (INR)', 17, 'right')} ${pad('DEVICE / ORIGIN', 22)} ${pad('MODE', 12)}${C.reset}`
  );
  if (snap.latestBids.length === 0) {
    console.log(` ${C.dim}No bidder offers committed yet. Place a bid from iPhone or Laptop!${C.reset}`);
  } else {
    for (const b of snap.latestBids) {
      const modeLabel = b.isAuto ? `${C.yellow}Auto-Pilot${C.reset}` : `${C.green}Manual/Live${C.reset}`;
      console.log(
        ` ${C.dim}${pad(b.time, 10)}${C.reset} ${C.cyan}${pad(b.lotId, 10)}${C.reset} ${pad(b.bidder, 18)} ${C.green}${pad(fmtINR(b.amount), 17, 'right')}${C.reset} ${C.magenta}${pad(b.device, 22)}${C.reset} ${modeLabel}`
      );
    }
  }

  console.log(`${C.dim}${line}${C.reset}`);
  console.log(`${C.bold}${C.white} [3] ACCOUNT LIQUIDITY & LOCKED ESCROW LEDGER (users TABLE)${C.reset}`);
  console.log(
    `${C.dim} ${pad('USERNAME', 16)} ${pad('ROLE', 10)} ${pad('AVAILABLE BALANCE', 22, 'right')} ${pad('LOCKED ESCROW', 22, 'right')} ${pad('ESCROW UTIL %', 16, 'right')}${C.reset}`
  );
  for (const u of snap.escrowUsers) {
    const total = Math.max(1, u.available + u.escrow);
    const pct = `${((u.escrow / total) * 100).toFixed(1)}%`;
    console.log(
      ` ${C.cyan}${pad('@' + u.username, 16)}${C.reset} ${pad(u.role.toUpperCase(), 10)} ${C.green}${pad(fmtINR(u.available), 22, 'right')}${C.reset} ${u.escrow > 0 ? C.yellow : C.dim}${pad(fmtINR(u.escrow), 22, 'right')}${C.reset} ${pad(pct, 16, 'right')}`
    );
  }

  console.log(`${C.dim}${line}${C.reset}`);
  console.log(
    `${C.dim} Refresh: ${REFRESH_MS}ms  |  Press Ctrl+C to exit  |  Window 1 of 3 (DB Watcher)${C.reset}`
  );
}

async function tick() {
  try {
    const snap = (await fetchFromPostgres()) ?? (await fetchFromLoopback());
    render(snap);
  } catch (err) {
    if (!ONCE_MODE) process.stdout.write('\x1b[2J\x1b[H');
    console.error(
      `${C.red}[AUTOAUC-DB] Waiting for AutoAuction server on 127.0.0.1:${PORT}... (${
        err instanceof Error ? err.message : 'unreachable'
      })${C.reset}`
    );
  }
}

async function main() {
  await tick();
  if (ONCE_MODE) {
    if (pgPool) await pgPool.end();
    process.exit(0);
  }
  const timer = setInterval(() => {
    void tick();
  }, REFRESH_MS);

  process.on('SIGINT', () => {
    clearInterval(timer);
    void pgPool?.end().finally(() => process.exit(0));
  });
}

void main();
