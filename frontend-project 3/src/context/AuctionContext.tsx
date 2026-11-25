import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AssetSubtype,
  AuctionCategory,
  AuctionLot,
  AuthSession,
  BackendStatus,
  DemoSpeed,
  ServerStateSnapshot,
  ToastItem,
  UserAccount,
  UserRole,
  WalletTransaction,
} from '../types/auction';
import { storage } from '../services/storage';
import { formatINR, playAuctionSound } from '../utils/format';

interface ActionResult {
  ok: boolean;
  error?: string;
}

interface CreateAuctionInput {
  title: string;
  description: string;
  category: AuctionCategory;
  assetType: AssetSubtype;
  year: number;
  condition: AuctionLot['condition'];
  location: string;
  reservePrice: number;
  durationMinutes: number;
  specs?: string[];
}

interface AuctionContextValue {
  session: AuthSession | null;
  currentUser: UserAccount | null;
  users: UserAccount[];
  auctions: AuctionLot[];
  transactions: WalletTransaction[];
  watchlist: string[];
  botActivityEnabled: boolean;
  botSpeed: DemoSpeed;
  backendStatus: BackendStatus | null;
  isHydrating: boolean;
  wsConnected: boolean;
  theme: 'dark' | 'light';
  soundEnabled: boolean;
  now: number;
  flashedLots: Record<string, number>;
  toasts: ToastItem[];
  toggleTheme: () => void;
  toggleSound: () => void;
  dismissToast: (id: string) => void;
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  login: (identifier: string, password: string) => Promise<ActionResult>;
  register: (input: {
    name: string;
    username: string;
    email: string;
    password: string;
    role: UserRole;
  }) => Promise<ActionResult>;
  logout: () => void;
  toggleWatchlist: (lotId: string) => void;
  placeBid: (lotId: string, amount: number) => Promise<ActionResult>;
  setProxyBid: (lotId: string, maxLimit: number | null) => Promise<ActionResult>;
  topUpWallet: (amount: number) => Promise<ActionResult>;
  createAuction: (input: CreateAuctionInput) => Promise<ActionResult>;
  updateAuction: (
    lotId: string,
    patch: Partial<Pick<AuctionLot, 'title' | 'description' | 'location' | 'condition' | 'reservePrice' | 'assetType' | 'category'>>
  ) => Promise<ActionResult>;
  deleteAuction: (lotId: string) => Promise<ActionResult>;
  moderateAuction: (
    lotId: string,
    decision: 'approve' | 'reject',
    reason?: string
  ) => Promise<ActionResult>;
  updateUserRole: (userId: string, role: UserRole) => Promise<ActionResult>;
  deleteUser: (userId: string) => Promise<ActionResult>;
  toggleBotActivity: () => Promise<ActionResult>;
  setBotSpeed: (speed: DemoSpeed) => Promise<ActionResult>;
  triggerBiddingWar: (lotId: string) => Promise<ActionResult>;
  resetDemoMarket: () => Promise<ActionResult>;
  replenishMarket: () => Promise<ActionResult>;
}

const AuctionContext = createContext<AuctionContextValue | null>(null);

export const AuctionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<AuthSession | null>(() => storage.getSession());
  const [users, setUsers] = useState<UserAccount[]>(() => storage.getUsers());
  const [auctions, setAuctions] = useState<AuctionLot[]>(() => storage.getAuctions());
  const [transactions, setTransactions] = useState<WalletTransaction[]>(() =>
    storage.getTransactions()
  );
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    const s = storage.getSession();
    return s ? storage.getUserWatchlist(s.userId) : [];
  });
  const [botActivityEnabled, setBotActivityEnabled] = useState(false);
  const [botSpeed, setBotSpeedState] = useState<DemoSpeed>(0);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => storage.getTheme());
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => storage.getSoundEnabled());
  const [now, setNow] = useState<number>(() => Date.now());
  const [flashedLots, setFlashedLots] = useState<Record<string, number>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const sessionRef = useRef(session);
  const soundRef = useRef(soundEnabled);
  sessionRef.current = session;
  soundRef.current = soundEnabled;

  // Apply Tailwind v4 .dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'dark' ? '#0B1120' : '#F8FAFC');
    }
    storage.saveTheme(theme);
  }, [theme]);

  // Global 1-second clock for live countdowns
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [{ ...toast, id }, ...prev].slice(0, 4));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const applySnapshot = useCallback((snapshot: ServerStateSnapshot) => {
    setUsers(snapshot.users);
    setAuctions(snapshot.auctions);
    setTransactions(snapshot.transactions);
    setBotActivityEnabled(snapshot.botActivityEnabled);
    setBotSpeedState(snapshot.botSpeed ?? (snapshot.botActivityEnabled ? 1 : 0));
    if (snapshot.backendStatus) {
      setBackendStatus(snapshot.backendStatus);
    }

    // Mirror authoritative server state to LocalStorage for Review 1 persistence & offline view
    storage.saveUsers(snapshot.users);
    storage.saveAuctions(snapshot.auctions);
    storage.saveTransactions(snapshot.transactions);

    // Keep stored session role/name synced if admin changed role
    const current = sessionRef.current;
    if (current) {
      const updatedMe = snapshot.users.find((u) => u.id === current.userId);
      if (updatedMe && (updatedMe.role !== current.role || updatedMe.name !== current.name)) {
        const nextSession: AuthSession = {
          ...current,
          role: updatedMe.role,
          name: updatedMe.name,
        };
        setSession(nextSession);
        storage.saveSession(nextSession);
      }
    }
  }, []);

  // Initial REST hydration + session verification
  useEffect(() => {
    let active = true;
    async function hydrate() {
      try {
        const stateRes = await fetch('/api/state');
        if (stateRes.ok) {
          const data = (await stateRes.json()) as ServerStateSnapshot;
          if (active) applySnapshot(data);
        }

        const saved = storage.getSession();
        if (saved?.token) {
          const meRes = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${saved.token}` },
          });
          if (meRes.status === 401 && active) {
            storage.clearSession();
            setSession(null);
            setWatchlist([]);
          }
        }
      } catch {
        // Offline mode: fallback cleanly to LocalStorage state already loaded
      } finally {
        if (active) setIsHydrating(false);
      }
    }
    hydrate();
    return () => {
      active = false;
    };
  }, [applySnapshot]);

  // Real-time WebSocket connection with auto-reconnect
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;
      try {
        ws = new WebSocket(url);
      } catch {
        return;
      }

      ws.onopen = () => {
        if (disposed) return;
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            lotId?: string;
            outbidUserId?: string;
            data?: ServerStateSnapshot;
          };

          if (msg.data) {
            applySnapshot(msg.data);
          }

          if (msg.type === 'bid:placed' && msg.lotId) {
            setFlashedLots((prev) => ({ ...prev, [msg.lotId!]: Date.now() }));
            const activeUserId = sessionRef.current?.userId;
            if (msg.outbidUserId && activeUserId === msg.outbidUserId) {
              const lot = msg.data?.auctions.find((a) => a.id === msg.lotId);
              playAuctionSound('outbid', soundRef.current);
              pushToast({
                title: 'You have been outbid',
                message: lot
                  ? `${lot.title} is now at ${formatINR(lot.bids[lot.bids.length - 1]?.amount ?? lot.reservePrice)}. Your escrow hold was released.`
                  : 'Another bidder placed a higher bid.',
                variant: 'warning',
                actionLabel: 'Counter-Bid',
                actionLotId: msg.lotId,
              });
            } else {
              playAuctionSound('bid', soundRef.current);
            }
          } else if (msg.type === 'auction:settled') {
            playAuctionSound('sold', soundRef.current);
          }
        } catch {
          // Ignore invalid socket payloads
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 2500);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [applySnapshot, pushToast]);

  const authedFetch = useCallback(
    async (url: string, init: RequestInit = {}) => {
      const token = sessionRef.current?.token;
      const headers = new Headers(init.headers);
      if (!headers.has('Content-Type') && init.body) {
        headers.set('Content-Type', 'application/json');
      }
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const res = await fetch(url, { ...init, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false as const, error: (data?.error as string) || 'Request failed.' };
      }
      return { ok: true as const, data };
    },
    []
  );

  const refreshState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (res.ok) {
        const snapshot = (await res.json()) as ServerStateSnapshot;
        applySnapshot(snapshot);
      }
    } catch {
      // Ignore offline refresh error
    }
  }, [applySnapshot]);

  const login = useCallback(
    async (identifier: string, password: string): Promise<ActionResult> => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          return { ok: false, error: data.error || 'Unable to sign in.' };
        }
        const user = data.user as UserAccount;
        const nextSession: AuthSession = {
          userId: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          role: user.role,
          token: data.token as string,
          loggedInAt: Date.now(),
        };
        setSession(nextSession);
        storage.saveSession(nextSession);
        setWatchlist(storage.getUserWatchlist(user.id));
        await refreshState();
        pushToast({
          title: `Welcome back, ${user.name}`,
          message: `Signed in as ${user.role === 'user' ? 'Bidder' : user.role === 'seller' ? 'Seller' : 'Administrator'}.`,
          variant: 'success',
        });
        return { ok: true };
      } catch {
        return { ok: false, error: 'Network error. Please check your connection.' };
      }
    },
    [pushToast, refreshState]
  );

  const register = useCallback(
    async (input: {
      name: string;
      username: string;
      email: string;
      password: string;
      role: UserRole;
    }): Promise<ActionResult> => {
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const data = await res.json();
        if (!res.ok) {
          return { ok: false, error: data.error || 'Registration failed.' };
        }
        const user = data.user as UserAccount;
        const nextSession: AuthSession = {
          userId: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          role: user.role,
          token: data.token as string,
          loggedInAt: Date.now(),
        };
        setSession(nextSession);
        storage.saveSession(nextSession);
        setWatchlist(storage.getUserWatchlist(user.id));
        await refreshState();
        pushToast({
          title: 'Account created',
          message: `Verified wallet funded with ${formatINR(user.availableBalance)}.`,
          variant: 'success',
        });
        return { ok: true };
      } catch {
        return { ok: false, error: 'Network error. Could not reach the server.' };
      }
    },
    [pushToast, refreshState]
  );

  const logout = useCallback(() => {
    storage.clearSession();
    setSession(null);
    setWatchlist([]);
    pushToast({ title: 'Signed out', message: 'Your session was cleared safely.', variant: 'info' });
  }, [pushToast]);

  const toggleWatchlist = useCallback(
    (lotId: string) => {
      const uid = sessionRef.current?.userId;
      if (!uid) return;
      const updated = storage.toggleWatchlist(uid, lotId);
      setWatchlist(updated);
      const added = updated.includes(lotId);
      pushToast({
        title: added ? 'Added to Watchlist' : 'Removed from Watchlist',
        variant: 'info',
      });
    },
    [pushToast]
  );

  const placeBid = useCallback(
    async (lotId: string, amount: number): Promise<ActionResult> => {
      const res = await authedFetch(`/api/auctions/${encodeURIComponent(lotId)}/bids`, {
        method: 'POST',
        body: JSON.stringify({ amount }),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({
        title: 'Bid confirmed',
        message: `Placed ${formatINR(amount)} on ${lotId}. Funds secured in escrow.`,
        variant: 'success',
      });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const setProxyBid = useCallback(
    async (lotId: string, maxLimit: number | null): Promise<ActionResult> => {
      const res = await authedFetch(`/api/auctions/${encodeURIComponent(lotId)}/proxy`, {
        method: 'POST',
        body: JSON.stringify({ maxLimit }),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({
        title: maxLimit === null ? 'Auto-Pilot disabled' : 'Auto-Pilot active',
        message:
          maxLimit === null
            ? `Proxy bidding stopped for ${lotId}.`
            : `Automatically bidding up to ${formatINR(maxLimit)} on ${lotId}.`,
        variant: 'success',
      });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const topUpWallet = useCallback(
    async (amount: number): Promise<ActionResult> => {
      const res = await authedFetch('/api/wallet/topup', {
        method: 'POST',
        body: JSON.stringify({ amount }),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({
        title: 'Wallet funded',
        message: `Added ${formatINR(amount)} to your available balance.`,
        variant: 'success',
      });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const createAuction = useCallback(
    async (input: CreateAuctionInput): Promise<ActionResult> => {
      const res = await authedFetch('/api/auctions', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      const lot = res.data.lot as AuctionLot;
      pushToast({
        title: lot.status === 'live' ? 'Lot published live' : 'Submitted for approval',
        message:
          lot.status === 'live'
            ? `${lot.id} is now accepting bids.`
            : `${lot.id} is queued in the Admin Control Center.`,
        variant: 'success',
      });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const updateAuction = useCallback(
    async (
      lotId: string,
      patch: Partial<Pick<AuctionLot, 'title' | 'description' | 'location' | 'condition' | 'reservePrice' | 'assetType' | 'category'>>
    ): Promise<ActionResult> => {
      const res = await authedFetch(`/api/auctions/${encodeURIComponent(lotId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({ title: 'Listing updated', message: `Saved changes to ${lotId}.`, variant: 'success' });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const deleteAuction = useCallback(
    async (lotId: string): Promise<ActionResult> => {
      const res = await authedFetch(`/api/auctions/${encodeURIComponent(lotId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({ title: 'Listing removed', message: `Deleted lot ${lotId}.`, variant: 'info' });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const moderateAuction = useCallback(
    async (lotId: string, decision: 'approve' | 'reject', reason?: string): Promise<ActionResult> => {
      const res = await authedFetch(`/api/admin/auctions/${encodeURIComponent(lotId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ decision, reason }),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({
        title: decision === 'approve' ? 'Listing approved' : 'Listing rejected',
        message:
          decision === 'approve'
            ? `${lotId} is now live across all connected devices.`
            : `${lotId} was returned to the seller.`,
        variant: decision === 'approve' ? 'success' : 'warning',
      });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const updateUserRole = useCallback(
    async (userId: string, role: UserRole): Promise<ActionResult> => {
      const res = await authedFetch(`/api/admin/users/${encodeURIComponent(userId)}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({ title: 'Role updated', message: `User role set to ${role}.`, variant: 'success' });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const deleteUser = useCallback(
    async (userId: string): Promise<ActionResult> => {
      const res = await authedFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({ title: 'Account deleted', variant: 'info' });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const toggleBotActivity = useCallback(async (): Promise<ActionResult> => {
    const res = await authedFetch('/api/admin/bot-toggle', { method: 'POST' });
    if (!res.ok) return { ok: false, error: res.error };
    await refreshState();
    pushToast({
      title: res.data.enabled ? 'Demo market bids enabled' : 'Demo market bids paused',
      variant: 'info',
    });
    return { ok: true };
  }, [authedFetch, pushToast, refreshState]);

  const setBotSpeed = useCallback(
    async (speed: DemoSpeed): Promise<ActionResult> => {
      const res = await authedFetch('/api/admin/demo/speed', {
        method: 'POST',
        body: JSON.stringify({ speed }),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await refreshState();
      pushToast({
        title: speed === 0 ? 'Auto-bid simulator paused' : `Demo speed set to ${speed}x`,
        message:
          speed === 0
            ? 'Live market activity returned to manual bidding only.'
            : `Competing bids streaming across all connected devices at ${speed}x pace.`,
        variant: 'info',
      });
      return { ok: true };
    },
    [authedFetch, pushToast, refreshState]
  );

  const triggerBiddingWar = useCallback(
    async (lotId: string): Promise<ActionResult> => {
      const res = await authedFetch(`/api/admin/demo/war/${encodeURIComponent(lotId)}`, {
        method: 'POST',
      });
      if (!res.ok) return { ok: false, error: res.error };
      pushToast({
        title: `Bidding war triggered on ${lotId}`,
        message: '5 rapid competing bids firing in real time across devices.',
        variant: 'warning',
        actionLabel: 'Inspect Lot',
        actionLotId: lotId,
      });
      return { ok: true };
    },
    [authedFetch, pushToast]
  );

  const resetDemoMarket = useCallback(async (): Promise<ActionResult> => {
    const res = await authedFetch('/api/admin/demo/reset', { method: 'POST' });
    if (!res.ok) return { ok: false, error: res.error };
    await refreshState();
    pushToast({
      title: 'Demo market reset',
      message: `Re-seeded ${res.data.totalLots} fresh lots across all 9 sectors.`,
      variant: 'success',
    });
    return { ok: true };
  }, [authedFetch, pushToast, refreshState]);

  const replenishMarket = useCallback(async (): Promise<ActionResult> => {
    const res = await authedFetch('/api/admin/replenish', { method: 'POST' });
    if (!res.ok) return { ok: false, error: res.error };
    await refreshState();
    pushToast({
      title: 'Market replenished',
      message: `Added ${res.data.added} fresh live lots.`,
      variant: 'success',
    });
    return { ok: true };
  }, [authedFetch, pushToast, refreshState]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;
      storage.saveSoundEnabled(next);
      if (next) playAuctionSound('bid', true);
      return next;
    });
  }, []);

  const currentUser = useMemo(() => {
    if (!session) return null;
    return (
      users.find((u) => u.id === session.userId) ?? {
        id: session.userId,
        name: session.name,
        username: session.username,
        email: session.email,
        role: session.role,
        availableBalance: 0,
        escrowBalance: 0,
        createdAt: session.loggedInAt,
      }
    );
  }, [session, users]);

  const value: AuctionContextValue = {
    session,
    currentUser,
    users,
    auctions,
    transactions,
    watchlist,
    botActivityEnabled,
    botSpeed,
    backendStatus,
    isHydrating,
    wsConnected,
    theme,
    soundEnabled,
    now,
    flashedLots,
    toasts,
    toggleTheme,
    toggleSound,
    dismissToast,
    pushToast,
    login,
    register,
    logout,
    toggleWatchlist,
    placeBid,
    setProxyBid,
    topUpWallet,
    createAuction,
    updateAuction,
    deleteAuction,
    moderateAuction,
    updateUserRole,
    deleteUser,
    toggleBotActivity,
    setBotSpeed,
    triggerBiddingWar,
    resetDemoMarket,
    replenishMarket,
  };

  return <AuctionContext.Provider value={value}>{children}</AuctionContext.Provider>;
};

export function useAuction() {
  const ctx = useContext(AuctionContext);
  if (!ctx) throw new Error('useAuction must be used inside AuctionProvider');
  return ctx;
}
