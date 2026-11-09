import * as SecureStore from 'expo-secure-store';

import { positionPnl } from '../api/pnl';
import type { ContractInfo, PendingOrder, Position } from '../api/types';
import { runAlerts, type WatchedPosition } from '../alerts/engine';
import { loadAlertSettings } from '../alerts/settings';
import { toWatched } from '../alerts/watch';
import { checkSignals } from '../signals/background';
import { errorMessage, type Exchange } from '../exchanges';
import { settle } from '../hooks/useFutures';
import { exchangeFor, loadCredentials } from '../storage/credentials';

export interface WidgetPosition {
  /** Exchange position id (string: may exceed 2^53). */
  id?: string;
  symbol: string;
  /** Short display name ("XAU"). */
  name?: string;
  long: boolean;
  leverage: number;
  pnl: number;
  roe?: number;
}

/** Everything the home-screen widget shows; cached so the widget can render instantly. */
export interface Snapshot {
  equity: number;
  unrealized: number;
  positions: WidgetPosition[];
  time: number;
  exchange?: string;
}

const CACHE_KEY = 'widget_snapshot_v1';

export async function loadCachedSnapshot(): Promise<Snapshot | null> {
  try {
    const json = await SecureStore.getItemAsync(CACHE_KEY);
    return json ? (JSON.parse(json) as Snapshot) : null;
  } catch {
    return null;
  }
}

export function cacheSnapshot(s: Snapshot) {
  return SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(s)).catch(() => {});
}

// The headless JS runtime survives between widget refreshes while the process lives, so these
// caches save a time sync and contract lookups on every tick.
let session: { key: string; api: Exchange; syncedAt: number } | null = null;
const contractCache = new Map<string, ContractInfo>();
const RESYNC_MS = 10 * 60_000;

async function getApi() {
  const creds = await loadCredentials();
  if (!creds) throw new Error('Chưa có API Key');
  const key = `${creds.exchange}|${creds.apiKey}|${creds.baseUrl}`;
  if (!session || session.key !== key) {
    session = { key, api: exchangeFor(creds.exchange, creds), syncedAt: 0 };
    contractCache.clear();
  }
  if (Date.now() - session.syncedAt > RESYNC_MS) {
    await session.api.syncTime();
    session.syncedAt = Date.now();
  }
  return session.api;
}

async function contractOf(api: Exchange, symbol: string) {
  let c = contractCache.get(symbol);
  if (!c) {
    c = await api.getContract(symbol);
    contractCache.set(symbol, c);
  }
  return c;
}

/**
 * Panic from the widget (app may be closed): cancel every pending order, then market-close every
 * position. Same sequence as the in-app "Đóng tất cả". Returns how many positions were sent a
 * close order and the readable failures.
 */
export async function panicCloseAll(): Promise<{ closed: number; errors: string[] }> {
  const api = await getApi();
  const errors = await api.cancelAll().catch((e) => [`Hủy lệnh: ${errorMessage(e)}`]);
  // Fresh positions: cancelling close orders changes frozenVol.
  const positions = await api.getOpenPositions();
  const prices = await Promise.all(
    [...new Set(positions.map((p) => p.symbol))].map(async (s) => [s, await api.getFairPrice(s).catch(() => 0)] as const),
  );
  const priceOf = new Map(prices);
  const failures = await settle(
    positions.map((p) => ({
      label: `${api.baseOf(p.symbol)} ${p.positionType === 1 ? 'Long' : 'Short'}`,
      run: () => api.closePositionMarket(p, priceOf.get(p.symbol) || p.holdAvgPrice),
    })),
  );
  return { closed: positions.length - failures.length, errors: [...errors, ...failures] };
}

/**
 * Market-closes one position from the widget. `target` is the row key: the position id, or
 * "SYMBOL|L" / "SYMBOL|S" for rows cached before ids were stored. Returns a display label.
 */
export async function closeOnePosition(target: string): Promise<string> {
  const api = await getApi();
  const positions = await api.getOpenPositions();
  const [sym, side] = target.split('|');
  const p =
    positions.find((x) => x.positionId === target) ??
    (side ? positions.find((x) => x.symbol === sym && (x.positionType === 1) === (side === 'L')) : undefined);
  if (!p) throw new Error('Vị thế đã đóng');
  const label = `${api.baseOf(p.symbol)} ${p.positionType === 1 ? 'Long' : 'Short'}`;
  // Volume locked by pending close orders would make the close fail: free it first (as in the app).
  if (p.frozenVol > 0) await api.cancelAll(p.symbol);
  const price = await api.getFairPrice(p.symbol).catch(() => 0);
  await api.closePositionMarket(p, price || p.holdAvgPrice);
  return label;
}

/** Fetches a fresh snapshot straight from MEXC (used by the widget while the app is closed). */
export async function fetchSnapshot(): Promise<Snapshot> {
  const api = await getApi();

  const [account, positions] = await Promise.all([api.getAccount(), api.getOpenPositions()]);
  const symbols = [...new Set(positions.map((p) => p.symbol))];
  const [contracts, tickers] = await Promise.all([
    Promise.all(symbols.map((s) => contractOf(api, s))),
    Promise.all(symbols.map((s) => api.getTicker(s))),
  ]);

  const rows = positions.map<WidgetPosition>((p) => {
    const i = symbols.indexOf(p.symbol);
    const { pnl, roe } = positionPnl(p, tickers[i].fairPrice, contracts[i]);
    return { id: p.positionId, symbol: p.symbol, name: api.baseOf(p.symbol), long: p.positionType === 1, leverage: p.leverage, pnl, roe };
  });

  const snap: Snapshot = {
    equity: account?.equity ?? 0,
    unrealized: rows.reduce((s, r) => s + r.pnl, 0),
    positions: rows,
    time: Date.now(),
    exchange: api.name,
  };
  await cacheSnapshot(snap);
  lastFetch = { api, positions, marks: new Map(symbols.map((s, i) => [s, tickers[i].fairPrice])), contracts: new Map(symbols.map((s, i) => [s, contracts[i]])) };
  return snap;
}

// Raw data of the last fetch, reused by the position alerts (no second round of requests).
let lastFetch: {
  api: Exchange;
  positions: Position[];
  marks: Map<string, number>;
  contracts: Map<string, ContractInfo>;
} | null = null;
let ordersCache: { at: number; orders: PendingOrder[] } | null = null;

/**
 * Runs the position alerts on the data of the last fetchSnapshot (used by the widget while the app
 * is closed). Pending orders (for TP/SL) are re-read at most once a minute.
 */
export async function checkAlertsAfterFetch() {
  const f = lastFetch;
  // Entry signals for gold / silver / oil (self-throttled to every 5 minutes).
  if (f) await checkSignals(f.api).catch(() => {});
  if (!f || !(await loadAlertSettings()).enabled) return;
  if (f.positions.length && (!ordersCache || Date.now() - ordersCache.at > 60_000)) {
    ordersCache = { at: Date.now(), orders: await f.api.getPendingOrders().catch(() => ordersCache?.orders ?? []) };
  }
  const watched = f.positions
    .map((p) => toWatched(f.api, p, f.marks.get(p.symbol), f.contracts.get(p.symbol), ordersCache?.orders ?? []))
    .filter((w): w is WatchedPosition => w !== null);
  await runAlerts(f.api, watched);
}
