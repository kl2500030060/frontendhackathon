import '../env.ts';

const PORT = Number(process.env.PORT) || 3000;
const MONITOR_URL = `http://127.0.0.1:${PORT}/api/internal/monitor`;
const ONCE_MODE = process.argv.includes('--once');
const REFRESH_MS = 2000;

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
};

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clean = value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
  return align === 'right' ? clean.padStart(width, ' ') : clean.padEnd(width, ' ');
}

function fmtTime(ts: number): string {
  return new Date(Number(ts) || Date.now()).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

interface SecurityMonitorPayload {
  database: {
    storageMode: 'postgresql' | 'memory';
    storageLabel: string;
  };
  connected: {
    total: number;
    mobile: number;
    desktop: number;
    clients: Array<{
      id: string;
      deviceLabel: string;
      ipAddress: string;
      connectedAt: number;
    }>;
  };
  activeSessions: Array<{
    tokenFingerprint: string;
    userId: string;
    username: string;
    role: string;
    deviceLabel: string;
    ipAddress: string;
    createdAt: number;
    lastSeenAt: number;
  }>;
  securityRows: Array<{
    userId: string;
    username: string;
    name: string;
    role: string;
    hashAlgorithm: string;
    saltPreview: string;
    hashFingerprint: string;
    availableBalance: number;
    escrowBalance: number;
  }>;
}

function render(data: SecurityMonitorPayload) {
  if (!ONCE_MODE) {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  const line = '─'.repeat(98);
  const nowStr = fmtTime(Date.now());

  console.log(`${C.bold}${C.magenta}╔${'═'.repeat(96)}╗${C.reset}`);
  console.log(
    `${C.bold}${C.magenta}║${C.reset} ${C.bold}AUTOAUC-SEC :: SALTED SCRYPT HASHES, ACTIVE SESSIONS & DEVICE AUDIT${C.reset}    ${C.dim}|${C.reset} ${C.yellow}${nowStr}${C.reset}          ${C.bold}${C.magenta}║${C.reset}`
  );
  console.log(`${C.bold}${C.magenta}╚${'═'.repeat(96)}╝${C.reset}`);

  console.log(
    ` ${C.bold}CRYPTO SPEC${C.reset}   ` +
      `Password KDF: ${C.green}scrypt (N=16384, r=8, p=1, 64B)${C.reset}  ` +
      `Salt: ${C.cyan}Unique 16B CSPRNG/user${C.reset}  ` +
      `Tokens: ${C.yellow}HMAC-SHA256${C.reset}`
  );
  console.log(
    ` ${C.bold}GUARDRAILS${C.reset}    ` +
      `Verify: ${C.green}crypto.timingSafeEqual${C.reset}  ` +
      `Monitor ACL: ${C.green}127.0.0.1 Loopback Only (HTTP 403 External)${C.reset}`
  );
  console.log(
    ` ${C.bold}LIVE SOCKETS${C.reset}  ` +
      `Total: ${C.cyan}${data.connected.total}${C.reset}  ` +
      `Mobile (iPhone/Android): ${C.green}${data.connected.mobile}${C.reset}  ` +
      `Desktop (Laptop): ${C.magenta}${data.connected.desktop}${C.reset}  ` +
      `Store: ${C.yellow}${data.database.storageMode.toUpperCase()}${C.reset}`
  );
  console.log(`${C.dim}${line}${C.reset}`);

  console.log(
    `${C.bold}${C.white} [1] PASSWORD HASH LEDGER (NON-REVERSIBLE TRUNCATED PREVIEWS — NEVER SENT TO BROWSER)${C.reset}`
  );
  console.log(
    `${C.dim} ${pad('USERNAME', 14)} ${pad('ROLE', 8)} ${pad('ALGORITHM', 19)} ${pad('UNIQUE SALT (16B)', 22)} ${pad('SCRYPT HASH FINGERPRINT (64B)', 30)}${C.reset}`
  );
  for (const row of data.securityRows) {
    console.log(
      ` ${C.cyan}${pad('@' + row.username, 14)}${C.reset} ${pad(row.role.toUpperCase(), 8)} ${C.green}${pad(row.hashAlgorithm, 19)}${C.reset} ${C.yellow}${pad(row.saltPreview, 22)}${C.reset} ${C.magenta}${pad(row.hashFingerprint, 30)}${C.reset}`
    );
  }

  console.log(`${C.dim}${line}${C.reset}`);
  console.log(
    `${C.bold}${C.white} [2] ACTIVE SIGNED SESSIONS (HMAC-SHA256 BEARER TOKENS — SHA-256 FINGERPRINTS)${C.reset}`
  );
  console.log(
    `${C.dim} ${pad('TOKEN FINGERPRINT', 24)} ${pad('USER', 14)} ${pad('ROLE', 8)} ${pad('DEVICE', 18)} ${pad('CLIENT IP', 16)} ${pad('LAST SEEN', 10)}${C.reset}`
  );
  if (data.activeSessions.length === 0) {
    console.log(
      ` ${C.dim}No signed-in sessions yet. Sign in on iPhone Safari or Laptop Chrome to inspect live tokens.${C.reset}`
    );
  } else {
    for (const s of data.activeSessions.slice(0, 8)) {
      console.log(
        ` ${C.yellow}${pad(s.tokenFingerprint, 24)}${C.reset} ${C.cyan}${pad('@' + s.username, 14)}${C.reset} ${pad(s.role.toUpperCase(), 8)} ${C.green}${pad(s.deviceLabel, 18)}${C.reset} ${pad(s.ipAddress, 16)} ${C.dim}${pad(fmtTime(s.lastSeenAt), 10)}${C.reset}`
      );
    }
  }

  console.log(`${C.dim}${line}${C.reset}`);
  console.log(`${C.bold}${C.white} [3] LIVE CONNECTED WEBSOCKET CLIENTS${C.reset}`);
  if (data.connected.clients.length === 0) {
    console.log(` ${C.dim}Waiting for browser / iPhone WebSocket connections on /ws...${C.reset}`);
  } else {
    for (const c of data.connected.clients.slice(0, 6)) {
      console.log(
        ` ${C.cyan}${pad(c.id, 14)}${C.reset} ${C.green}${pad(c.deviceLabel, 22)}${C.reset} IP: ${pad(c.ipAddress, 18)} Connected: ${C.dim}${fmtTime(c.connectedAt)}${C.reset}`
      );
    }
  }

  console.log(`${C.dim}${line}${C.reset}`);
  console.log(
    `${C.dim} Refresh: ${REFRESH_MS}ms  |  Press Ctrl+C to exit  |  Window 2 of 3 (Security & Sessions)${C.reset}`
  );
}

async function tick() {
  try {
    const res = await fetch(MONITOR_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as SecurityMonitorPayload;
    render(data);
  } catch (err) {
    if (!ONCE_MODE) process.stdout.write('\x1b[2J\x1b[H');
    console.error(
      `${C.red}[AUTOAUC-SEC] Waiting for AutoAuction server on 127.0.0.1:${PORT}... (${
        err instanceof Error ? err.message : 'unreachable'
      })${C.reset}`
    );
  }
}

async function main() {
  await tick();
  if (ONCE_MODE) process.exit(0);
  const timer = setInterval(() => {
    void tick();
  }, REFRESH_MS);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

void main();
