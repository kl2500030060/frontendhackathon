import '../env.ts';
import http from 'http';

const PORT = Number(process.env.PORT) || 3000;
const ONCE_MODE = process.argv.includes('--once');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  white: '\x1b[37m',
};

interface StreamEvent {
  id: number;
  eventType: string;
  actorName: string;
  deviceLabel: string;
  lotId?: string;
  summary: string;
  sqlDurationMs: number;
  createdAt: number;
}

function fmtTime(ts: number): string {
  return new Date(Number(ts) || Date.now()).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function colorDevice(device: string): string {
  if (/iPhone|iPad|Android/i.test(device)) return `${C.brightCyan}[${device}]${C.reset}`;
  if (/Windows|macOS|Linux/i.test(device)) return `${C.magenta}[${device}]${C.reset}`;
  if (/Demo|War/i.test(device)) return `${C.yellow}[${device}]${C.reset}`;
  return `${C.green}[${device}]${C.reset}`;
}

function colorEventType(eventType: string): string {
  if (eventType.startsWith('bid:')) return `${C.green}${eventType.padEnd(15)}${C.reset}`;
  if (eventType.startsWith('auth:denied')) return `${C.red}${eventType.padEnd(15)}${C.reset}`;
  if (eventType.startsWith('auth:')) return `${C.cyan}${eventType.padEnd(15)}${C.reset}`;
  if (eventType.startsWith('demo:')) return `${C.yellow}${eventType.padEnd(15)}${C.reset}`;
  if (eventType.startsWith('ws:')) return `${C.dim}${eventType.padEnd(15)}${C.reset}`;
  return `${C.white}${eventType.padEnd(15)}${C.reset}`;
}

function printEvent(ev: StreamEvent) {
  const ts = `${C.dim}[${fmtTime(ev.createdAt)}]${C.reset}`;
  const dev = colorDevice(ev.deviceLabel || 'System');
  const type = colorEventType(ev.eventType || 'event');
  const sqlBadge =
    ev.sqlDurationMs > 0
      ? ` ${C.green}(SQL ${ev.sqlDurationMs.toFixed(1)}ms)${C.reset}`
      : '';
  console.log(`${ts} ${type} ${dev} ${C.bold}${ev.actorName}${C.reset} → ${ev.summary}${sqlBadge}`);
}

function printBanner() {
  if (!ONCE_MODE) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
  console.log(`${C.bold}${C.green}╔${'═'.repeat(94)}╗${C.reset}`);
  console.log(
    `${C.bold}${C.green}║${C.reset} ${C.bold}AUTOAUC-STREAM :: LIVE MULTI-DEVICE TRAFFIC & SQL COMMIT STREAM${C.reset}    ${C.dim}|${C.reset} ${C.cyan}Window 3 of 3${C.reset}          ${C.bold}${C.green}║${C.reset}`
  );
  console.log(`${C.bold}${C.green}╚${'═'.repeat(94)}╝${C.reset}`);
  console.log(
    `${C.dim} Listening to loopback SSE http://127.0.0.1:${PORT}/api/internal/events (Ctrl+C to stop)${C.reset}`
  );
  console.log(`${C.dim}${'─'.repeat(96)}${C.reset}`);
}

function connect() {
  let buffer = '';
  const req = http.get(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/api/internal/events',
      headers: { Accept: 'text/event-stream' },
    },
    (res) => {
      if (res.statusCode !== 200) {
        console.error(
          `${C.red}[AUTOAUC-STREAM] Server returned HTTP ${res.statusCode}. Retrying in 2s...${C.reset}`
        );
        res.resume();
        if (!ONCE_MODE) setTimeout(connect, 2000);
        return;
      }

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as StreamEvent;
            printEvent(payload);
          } catch {
            // Ignore malformed keepalive frames
          }
        }
      });

      res.on('end', () => {
        if (ONCE_MODE) process.exit(0);
        console.log(`${C.yellow}[AUTOAUC-STREAM] Stream closed. Reconnecting in 2s...${C.reset}`);
        setTimeout(connect, 2000);
      });
    }
  );

  req.on('error', (err) => {
    console.error(
      `${C.red}[AUTOAUC-STREAM] Waiting for AutoAuction server on 127.0.0.1:${PORT} (${err.message})...${C.reset}`
    );
    if (ONCE_MODE) process.exit(1);
    setTimeout(connect, 2000);
  });

  if (ONCE_MODE) {
    setTimeout(() => {
      req.destroy();
      process.exit(0);
    }, 600);
  }
}

printBanner();
connect();
