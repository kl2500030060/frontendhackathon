import './server/env.ts';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { auctionStore, verifySessionToken } from './server/store.ts';
import { printStartupBanner } from './server/network.ts';
import {
  classifyDevice,
  getDatabaseStatus,
  hashTokenFingerprint,
  initDatabase,
} from './server/db.ts';
import { serverTelemetry } from './server/telemetry.ts';
import type { DemoSpeed, UserRole } from './src/types/auction.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const IS_PROD =
  process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

const SPEED_INTERVAL_MS: Record<DemoSpeed, number | null> = {
  0: null,
  1: 4500,
  2: 2200,
  5: 900,
  10: 450,
};

interface AuthedRequest extends Request {
  userId?: string;
  tokenFingerprint?: string;
  deviceLabel?: string;
  clientIp?: string;
}

function getClientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return (req.socket?.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');
}

function isLoopbackRequest(req: Request): boolean {
  // Never trust X-Forwarded-For for loopback authorization — check actual TCP socket address
  const raw = req.socket.remoteAddress || '';
  return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = header.slice(7).trim();
  const userId = verifySessionToken(token);
  if (!userId || !auctionStore.getUserById(userId)) {
    res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
    return;
  }
  const fp = hashTokenFingerprint(token);
  const dev = classifyDevice(req.headers['user-agent']);
  req.userId = userId;
  req.tokenFingerprint = fp;
  req.deviceLabel = dev;
  req.clientIp = getClientIp(req);
  void serverTelemetry.touchSession(fp, dev);
  next();
}

async function startServer() {
  // Initialize PostgreSQL 16 if DATABASE_URL is present; gracefully fallback to local memory otherwise
  await initDatabase();
  await auctionStore.hydrateFromPostgres();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (payload: Record<string, unknown>) => {
    const encoded = JSON.stringify(payload);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(encoded);
      }
    });
  };

  wss.on('connection', (socket, req) => {
    const socketId = `ws_${crypto.randomBytes(4).toString('hex')}`;
    const deviceLabel = classifyDevice(req.headers['user-agent']);
    const ip = getClientIp(req);

    serverTelemetry.registerSocket(socketId, deviceLabel, ip);
    socket.send(JSON.stringify({ type: 'state:sync', data: auctionStore.getSnapshot() }));

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
        } else if (msg.type === 'request:sync') {
          socket.send(JSON.stringify({ type: 'state:sync', data: auctionStore.getSnapshot() }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      serverTelemetry.unregisterSocket(socketId);
    });
  });

  // Periodic settlement check
  setInterval(() => {
    void auctionStore.settleExpiredAuctions().then((settled) => {
      if (settled.length > 0) {
        for (const lot of settled) {
          void serverTelemetry.recordEvent({
            eventType: 'auction:settled',
            actorName: 'Settlement Engine',
            deviceLabel: 'Server Cron',
            lotId: lot.id,
            summary: `Lot ${lot.id} settled as ${lot.status.toUpperCase()}`,
          });
        }
        broadcast({
          type: 'auction:settled',
          lotIds: settled.map((s) => s.id),
          data: auctionStore.getSnapshot(),
        });
      }
    });
  }, 2000);

  // Dynamic Demo Speed scheduler (1x / 2x / 5x / 10x)
  let botTimer: ReturnType<typeof setInterval> | null = null;
  const activeWarTimers = new Set<ReturnType<typeof setTimeout>>();

  const clearAllWars = () => {
    activeWarTimers.forEach((t) => clearTimeout(t));
    activeWarTimers.clear();
  };

  const rescheduleBotLoop = () => {
    if (botTimer) {
      clearInterval(botTimer);
      botTimer = null;
    }
    const intervalMs = SPEED_INTERVAL_MS[auctionStore.getBotSpeed()];
    if (!intervalMs) return;

    botTimer = setInterval(() => {
      void auctionStore.runOptionalBotTick().then((botEvent) => {
        if (botEvent) {
          const top = botEvent.lot.bids[botEvent.lot.bids.length - 1];
          void serverTelemetry.recordEvent({
            eventType: 'bid:demo',
            actorName: top?.bidderName ?? 'Demo Bot',
            deviceLabel: `Demo Engine (${auctionStore.getBotSpeed()}x)`,
            lotId: botEvent.lot.id,
            summary: `Auto-bid ₹${(top?.amount ?? 0).toLocaleString('en-IN')} on ${botEvent.lot.id}`,
            sqlDurationMs: botEvent.sqlDurationMs,
          });
          broadcast({
            type: 'bid:placed',
            lotId: botEvent.lot.id,
            outbidUserId: botEvent.outbidUserId,
            autoPilotTriggered: botEvent.autoPilotTriggered,
            data: auctionStore.getSnapshot(),
          });
        }
      });
    }, intervalMs);
  };

  // --- INTERNAL LOOPBACK-ONLY MONITOR ENDPOINTS (For local Ubuntu SSH CLI monitors ONLY) ---
  app.get('/api/internal/monitor', (req, res) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: 'Local SSH loopback access only.' });
      return;
    }
    const snapshot = auctionStore.getSnapshot();
    res.json({
      database: getDatabaseStatus(),
      connected: serverTelemetry.getConnectedSummary(),
      activeSessions: serverTelemetry.getActiveSessions(),
      securityRows: auctionStore.getSecurityAuditRows(),
      recentEvents: serverTelemetry.getRecentEvents(40),
      auctions: snapshot.auctions,
      transactions: snapshot.transactions.slice(0, 25),
      botSpeed: snapshot.botSpeed,
      serverTime: Date.now(),
    });
  });

  app.get('/api/internal/events', (req, res) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: 'Local SSH loopback access only.' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const backlog = serverTelemetry.getRecentEvents(15).reverse();
    for (const ev of backlog) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    const unsubscribe = serverTelemetry.onEvent((ev) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });

    const keepalive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  // --- PUBLIC & AUTHENTICATED API ROUTES ---
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      database: getDatabaseStatus().storageMode,
      serverTime: Date.now(),
    });
  });

  app.get('/api/state', (_req, res) => {
    res.json(auctionStore.getSnapshot());
  });

  app.post('/api/auth/register', async (req, res) => {
    const { name, username, email, password, role } = req.body ?? {};
    if (
      typeof name !== 'string' ||
      typeof username !== 'string' ||
      typeof email !== 'string' ||
      typeof password !== 'string'
    ) {
      res.status(400).json({ error: 'All registration fields are required.' });
      return;
    }
    const result = await auctionStore.registerUser({
      name,
      username,
      email,
      password,
      role: (role as UserRole) || 'user',
    });
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    const deviceLabel = classifyDevice(req.headers['user-agent']);
    const ip = getClientIp(req);
    await serverTelemetry.recordSession({
      tokenFingerprint: hashTokenFingerprint(result.token),
      userId: result.user.id,
      username: result.user.username,
      role: result.user.role,
      deviceLabel,
      ipAddress: ip,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    await serverTelemetry.recordEvent({
      eventType: 'auth:register',
      actorName: `${result.user.name} (@${result.user.username})`,
      deviceLabel,
      summary: `New ${result.user.role} registered with salted scrypt hash`,
      sqlDurationMs: result.sqlDurationMs,
    });
    broadcast({ type: 'state:sync', data: auctionStore.getSnapshot() });
    res.status(201).json({ user: result.user, token: result.token });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { identifier, password } = req.body ?? {};
    if (typeof identifier !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Username/email and password are required.' });
      return;
    }
    const result = auctionStore.loginUser(identifier, password);
    if ('error' in result) {
      void serverTelemetry.recordEvent({
        eventType: 'auth:denied',
        actorName: String(identifier).slice(0, 32),
        deviceLabel: classifyDevice(req.headers['user-agent']),
        summary: 'Failed password verification (timing-safe scrypt rejected)',
      });
      res.status(401).json({ error: result.error });
      return;
    }
    const deviceLabel = classifyDevice(req.headers['user-agent']);
    const ip = getClientIp(req);
    await serverTelemetry.recordSession({
      tokenFingerprint: hashTokenFingerprint(result.token),
      userId: result.user.id,
      username: result.user.username,
      role: result.user.role,
      deviceLabel,
      ipAddress: ip,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    await serverTelemetry.recordEvent({
      eventType: 'auth:login',
      actorName: `${result.user.name} (@${result.user.username})`,
      deviceLabel,
      summary: `Authenticated via scrypt + HMAC-SHA256 session issued`,
    });
    res.json(result);
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    const user = auctionStore.getUserById(req.userId!);
    if (!user) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    res.json({ user });
  });

  app.post('/api/wallet/topup', requireAuth, async (req: AuthedRequest, res) => {
    const amount = Number(req.body?.amount);
    const result = await auctionStore.topUpWallet(req.userId!, amount);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    await serverTelemetry.recordEvent({
      eventType: 'wallet:topup',
      actorName: result.user.name,
      deviceLabel: req.deviceLabel || 'Web Client',
      summary: `Credited ₹${Math.round(amount).toLocaleString('en-IN')} to escrow wallet`,
      sqlDurationMs: result.sqlDurationMs,
    });
    broadcast({ type: 'wallet:updated', userId: req.userId, data: auctionStore.getSnapshot() });
    res.json({ user: result.user, txn: result.txn });
  });

  app.post('/api/auctions', requireAuth, async (req: AuthedRequest, res) => {
    const body = req.body ?? {};
    const result = await auctionStore.createAuction(req.userId!, {
      title: String(body.title ?? ''),
      description: String(body.description ?? ''),
      category: body.category,
      assetType: body.assetType,
      year: Number(body.year),
      condition: body.condition,
      location: String(body.location ?? ''),
      reservePrice: Number(body.reservePrice),
      durationMinutes: Number(body.durationMinutes),
      specs: Array.isArray(body.specs) ? body.specs.map(String) : undefined,
    });
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    await serverTelemetry.recordEvent({
      eventType: 'auction:created',
      actorName: result.lot.sellerName,
      deviceLabel: req.deviceLabel || 'Web Client',
      lotId: result.lot.id,
      summary: `Listed ${result.lot.id} (${result.lot.status}) at ₹${result.lot.reservePrice.toLocaleString('en-IN')}`,
      sqlDurationMs: result.sqlDurationMs,
    });
    broadcast({ type: 'auction:created', lotId: result.lot.id, data: auctionStore.getSnapshot() });
    res.status(201).json({ lot: result.lot });
  });

  app.patch('/api/auctions/:id', requireAuth, async (req: AuthedRequest, res) => {
    const lotId = String(req.params.id);
    const body = req.body ?? {};
    const result = await auctionStore.updateAuction(req.userId!, lotId, {
      title: typeof body.title === 'string' ? body.title : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      location: typeof body.location === 'string' ? body.location : undefined,
      condition: body.condition,
      category: body.category,
      assetType: body.assetType,
      reservePrice: body.reservePrice !== undefined ? Number(body.reservePrice) : undefined,
    });
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    broadcast({ type: 'auction:updated', lotId, data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.delete('/api/auctions/:id', requireAuth, async (req: AuthedRequest, res) => {
    const lotId = String(req.params.id);
    const result = await auctionStore.deleteAuction(req.userId!, lotId);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    broadcast({ type: 'auction:deleted', lotId, data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.post('/api/auctions/:id/bids', requireAuth, async (req: AuthedRequest, res) => {
    const lotId = String(req.params.id);
    const amount = Number(req.body?.amount);
    const deviceLabel = req.deviceLabel || 'Web Client';
    const result = await auctionStore.placeBid(lotId, req.userId!, amount, false, deviceLabel);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    const actor = auctionStore.getUserById(req.userId!);
    await serverTelemetry.recordEvent({
      eventType: 'bid:placed',
      actorName: actor?.name || 'Bidder',
      deviceLabel,
      lotId,
      summary: `Bid ₹${Math.round(amount).toLocaleString('en-IN')} on ${lotId}${result.autoPilotTriggered ? ' (Auto-Pilot countered)' : ''}`,
      sqlDurationMs: result.sqlDurationMs,
    });
    broadcast({
      type: 'bid:placed',
      lotId,
      outbidUserId: result.outbidUserId,
      autoPilotTriggered: result.autoPilotTriggered,
      data: auctionStore.getSnapshot(),
    });
    res.status(201).json(result);
  });

  app.post('/api/auctions/:id/proxy', requireAuth, async (req: AuthedRequest, res) => {
    const lotId = String(req.params.id);
    const rawLimit = req.body?.maxLimit;
    const maxLimit = rawLimit === null ? null : Number(rawLimit);
    const deviceLabel = req.deviceLabel || 'Web Client';
    const result = await auctionStore.setProxyBid(lotId, req.userId!, maxLimit, deviceLabel);
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    const actor = auctionStore.getUserById(req.userId!);
    await serverTelemetry.recordEvent({
      eventType: 'proxy:updated',
      actorName: actor?.name || 'Bidder',
      deviceLabel,
      lotId,
      summary:
        maxLimit === null
          ? `Disabled Auto-Pilot on ${lotId}`
          : `Armed Auto-Pilot up to ₹${Math.round(maxLimit).toLocaleString('en-IN')} on ${lotId}`,
      sqlDurationMs: result.sqlDurationMs,
    });
    broadcast({ type: 'bid:placed', lotId, data: auctionStore.getSnapshot() });
    res.json({ lot: result.lot });
  });

  app.patch('/api/admin/auctions/:id/status', requireAuth, async (req: AuthedRequest, res) => {
    const lotId = String(req.params.id);
    const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const result = await auctionStore.moderateAuction(req.userId!, lotId, decision, reason);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    await serverTelemetry.recordEvent({
      eventType: 'admin:moderate',
      actorName: 'Admin',
      deviceLabel: req.deviceLabel || 'Web Client',
      lotId,
      summary: `Lot ${lotId} ${decision === 'approve' ? 'APPROVED → LIVE' : 'REJECTED'}`,
    });
    broadcast({ type: 'auction:updated', lotId, data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.patch('/api/admin/users/:id/role', requireAuth, async (req: AuthedRequest, res) => {
    const targetId = String(req.params.id);
    const role = req.body?.role as UserRole;
    const result = await auctionStore.updateUserRole(req.userId!, targetId, role);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    broadcast({ type: 'state:sync', data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.delete('/api/admin/users/:id', requireAuth, async (req: AuthedRequest, res) => {
    const targetId = String(req.params.id);
    const result = await auctionStore.deleteUser(req.userId!, targetId);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    broadcast({ type: 'state:sync', data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.post('/api/admin/bot-toggle', requireAuth, (req: AuthedRequest, res) => {
    const result = auctionStore.toggleBotActivity(req.userId!);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    rescheduleBotLoop();
    broadcast({ type: 'state:sync', data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.post('/api/admin/demo/speed', requireAuth, (req: AuthedRequest, res) => {
    const speed = Number(req.body?.speed) as DemoSpeed;
    const result = auctionStore.setBotSpeed(req.userId!, speed);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    rescheduleBotLoop();
    void serverTelemetry.recordEvent({
      eventType: 'demo:speed',
      actorName: 'Admin',
      deviceLabel: req.deviceLabel || 'Web Client',
      summary: speed === 0 ? 'Auto-Bid simulator paused (OFF)' : `Auto-Bid speed set to ${speed}x`,
    });
    broadcast({ type: 'state:sync', data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.post('/api/admin/demo/war/:id', requireAuth, async (req: AuthedRequest, res) => {
    if (!auctionStore.isAdmin(req.userId!)) {
      res.status(403).json({ error: 'Admin access required.' });
      return;
    }
    const lotId = String(req.params.id);
    const firstTick = await auctionStore.triggerBiddingWarStep(lotId, 'Demo War Burst');
    if (!firstTick) {
      res.status(400).json({ error: 'Selected lot is not live or cannot accept demo bids.' });
      return;
    }

    const top = firstTick.lot.bids[firstTick.lot.bids.length - 1];
    await serverTelemetry.recordEvent({
      eventType: 'demo:war',
      actorName: top?.bidderName || 'Demo Bot',
      deviceLabel: 'Demo War Burst',
      lotId,
      summary: `War burst #1 → ₹${(top?.amount ?? 0).toLocaleString('en-IN')} on ${lotId}`,
      sqlDurationMs: firstTick.sqlDurationMs,
    });

    broadcast({
      type: 'bid:placed',
      lotId,
      outbidUserId: firstTick.outbidUserId,
      autoPilotTriggered: firstTick.autoPilotTriggered,
      data: auctionStore.getSnapshot(),
    });

    for (let step = 1; step <= 4; step++) {
      const timer = setTimeout(() => {
        activeWarTimers.delete(timer);
        void auctionStore.triggerBiddingWarStep(lotId, 'Demo War Burst').then((tick) => {
          if (tick) {
            const latest = tick.lot.bids[tick.lot.bids.length - 1];
            void serverTelemetry.recordEvent({
              eventType: 'demo:war',
              actorName: latest?.bidderName || 'Demo Bot',
              deviceLabel: 'Demo War Burst',
              lotId,
              summary: `War burst #${step + 1} → ₹${(latest?.amount ?? 0).toLocaleString('en-IN')} on ${lotId}`,
              sqlDurationMs: tick.sqlDurationMs,
            });
            broadcast({
              type: 'bid:placed',
              lotId,
              outbidUserId: tick.outbidUserId,
              autoPilotTriggered: tick.autoPilotTriggered,
              data: auctionStore.getSnapshot(),
            });
          }
        });
      }, step * 650);
      activeWarTimers.add(timer);
    }

    res.json({ ok: true, lotId, steps: 5 });
  });

  app.post('/api/admin/demo/reset', requireAuth, async (req: AuthedRequest, res) => {
    clearAllWars();
    const result = await auctionStore.resetDemoMarket(req.userId!);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    rescheduleBotLoop();
    await serverTelemetry.recordEvent({
      eventType: 'demo:reset',
      actorName: 'Admin',
      deviceLabel: req.deviceLabel || 'Web Client',
      summary: `Market re-seeded cleanly (${result.totalLots} lots across 9 sectors)`,
      sqlDurationMs: result.sqlDurationMs,
    });
    broadcast({ type: 'state:sync', data: auctionStore.getSnapshot() });
    res.json(result);
  });

  app.post('/api/admin/replenish', requireAuth, async (req: AuthedRequest, res) => {
    const result = await auctionStore.replenishDemoMarket(req.userId!);
    if ('error' in result) {
      res.status(403).json({ error: result.error });
      return;
    }
    broadcast({ type: 'state:sync', data: auctionStore.getSnapshot() });
    res.json(result);
  });

  // --- FRONTEND SERVING (Vite middleware in dev, dist/ in prod) ---
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, HOST, () => {
    void printStartupBanner(PORT, IS_PROD);
  });
}

startServer().catch((err) => {
  console.error('Failed to start AutoAuction server:', err);
  process.exit(1);
});
