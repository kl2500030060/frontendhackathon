import { getPool, isMobileDevice } from './db.ts';
import type { UserRole } from '../src/types/auction.ts';

export interface ActiveSessionRecord {
  tokenFingerprint: string;
  userId: string;
  username: string;
  role: UserRole;
  deviceLabel: string;
  ipAddress: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface ConnectedSocketClient {
  id: string;
  deviceLabel: string;
  ipAddress: string;
  connectedAt: number;
}

export interface DeviceEventRecord {
  id: number;
  eventType: string;
  actorName: string;
  deviceLabel: string;
  lotId?: string;
  summary: string;
  sqlDurationMs: number;
  createdAt: number;
}

type EventListener = (event: DeviceEventRecord) => void;

class ServerTelemetry {
  private sessions = new Map<string, ActiveSessionRecord>();
  private sockets = new Map<string, ConnectedSocketClient>();
  private events: DeviceEventRecord[] = [];
  private listeners = new Set<EventListener>();
  private nextEventId = 1;

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  registerSocket(id: string, deviceLabel: string, ipAddress: string): void {
    this.sockets.set(id, {
      id,
      deviceLabel,
      ipAddress,
      connectedAt: Date.now(),
    });
    void this.recordEvent({
      eventType: 'ws:connect',
      actorName: 'Guest / Client',
      deviceLabel,
      summary: `WebSocket connected from ${ipAddress} (${this.sockets.size} active)`,
      sqlDurationMs: 0,
    });
  }

  unregisterSocket(id: string): void {
    const existing = this.sockets.get(id);
    this.sockets.delete(id);
    if (existing) {
      void this.recordEvent({
        eventType: 'ws:disconnect',
        actorName: 'Client',
        deviceLabel: existing.deviceLabel,
        summary: `WebSocket closed (${this.sockets.size} remaining)`,
        sqlDurationMs: 0,
      });
    }
  }

  async recordSession(session: ActiveSessionRecord): Promise<void> {
    this.sessions.set(session.tokenFingerprint, session);
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO active_sessions
            (token_fingerprint, user_id, username, role, device_label, ip_address, created_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (token_fingerprint) DO UPDATE
           SET last_seen_at = EXCLUDED.last_seen_at,
               device_label = EXCLUDED.device_label,
               ip_address = EXCLUDED.ip_address`,
          [
            session.tokenFingerprint,
            session.userId,
            session.username,
            session.role,
            session.deviceLabel,
            session.ipAddress,
            session.createdAt,
            session.lastSeenAt,
          ]
        );
      } catch {
        // Non-fatal telemetry write
      }
    }
  }

  async touchSession(tokenFingerprint: string, deviceLabel?: string): Promise<void> {
    const now = Date.now();
    const existing = this.sessions.get(tokenFingerprint);
    if (existing) {
      existing.lastSeenAt = now;
      if (deviceLabel) existing.deviceLabel = deviceLabel;
    }
    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE active_sessions SET last_seen_at = $1 WHERE token_fingerprint = $2`,
          [now, tokenFingerprint]
        );
      } catch {
        // Non-fatal
      }
    }
  }

  async recordEvent(input: {
    eventType: string;
    actorName: string;
    deviceLabel: string;
    lotId?: string;
    summary: string;
    sqlDurationMs?: number;
  }): Promise<DeviceEventRecord> {
    const entry: DeviceEventRecord = {
      id: this.nextEventId++,
      eventType: input.eventType,
      actorName: input.actorName,
      deviceLabel: input.deviceLabel,
      lotId: input.lotId,
      summary: input.summary,
      sqlDurationMs: Math.round((input.sqlDurationMs ?? 0) * 10) / 10,
      createdAt: Date.now(),
    };

    this.events.unshift(entry);
    if (this.events.length > 250) {
      this.events.length = 250;
    }

    this.listeners.forEach((fn) => {
      try {
        fn(entry);
      } catch {
        // Ignore listener error
      }
    });

    const pool = getPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO device_events
            (event_type, actor_name, device_label, lot_id, summary, sql_duration_ms, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            entry.eventType,
            entry.actorName,
            entry.deviceLabel,
            entry.lotId ?? null,
            entry.summary,
            entry.sqlDurationMs,
            entry.createdAt,
          ]
        );
      } catch {
        // Non-fatal
      }
    }

    return entry;
  }

  getConnectedSummary() {
    let mobile = 0;
    let desktop = 0;
    const clients = Array.from(this.sockets.values());
    for (const c of clients) {
      if (isMobileDevice(c.deviceLabel)) mobile++;
      else desktop++;
    }
    return {
      total: clients.length,
      mobile,
      desktop,
      clients,
    };
  }

  getActiveSessions(): ActiveSessionRecord[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  getRecentEvents(limit = 40): DeviceEventRecord[] {
    return this.events.slice(0, limit);
  }

  clearSessionsAndEvents(): void {
    this.events = [];
  }
}

export const serverTelemetry = new ServerTelemetry();
