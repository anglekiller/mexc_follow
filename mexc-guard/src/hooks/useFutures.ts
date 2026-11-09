import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { positionPnl } from '../api/pnl';
import { tpslOf } from '../api/tpsl';
import type { Asset, ContractInfo, NewOrder, PendingOrder, Position } from '../api/types';
import { ExchangeError, errorMessage, type PriceStream, type StreamStatus } from '../exchanges';
import { exchangeFor, type Credentials } from '../storage/credentials';

export { errorMessage };
export type SocketStatus = StreamStatus;

const POLL_MS = 4_000;
// fair.price is only pushed when it changes (gaps of 15s+ are normal), so a symbol without a
// push for this long gets its price from REST as well.
const MARK_STALE_MS = 6_000;
// Price pushes are applied in batches: every state update redraws the open tab.
const MARK_FLUSH_MS = 250;

/** State updater that keeps the old reference when a poll returned identical data. */
const keepIfSame = <T,>(next: T) => (prev: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next);

export interface PositionView extends Position {
  mark?: number;
  contract?: ContractInfo;
  pnl?: number;
  roe?: number;
}

export type Futures = ReturnType<typeof useFutures>;

/** Round down to a multiple of `unit`, keeping `scale` decimals. */
export const floorToUnit = (v: number, unit: number, scale: number) =>
  Number((Math.floor(v / unit + 1e-9) * unit).toFixed(scale));

/** Run tasks, collect failures as readable lines instead of stopping at the first one. */
export async function settle(tasks: { label: string; run: () => Promise<unknown> }[]) {
  const results = await Promise.allSettled(tasks.map((t) => t.run()));
  return results.flatMap((r, i) =>
    r.status === 'rejected' ? [`${tasks[i].label}: ${errorMessage(r.reason)}`] : [],
  );
}

export function useFutures(creds: Credentials | null) {
  const api = useMemo(
    () => (creds ? exchangeFor(creds.exchange, creds) : null),
    [creds],
  );

  const [asset, setAsset] = useState<Asset | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [marks, setMarks] = useState<Record<string, number>>({});
  const [contracts, setContracts] = useState<Record<string, ContractInfo>>({});
  // Symbol open in the trade form: streamed alongside held symbols.
  const [watched, setWatched] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<SocketStatus>('closed');
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const inFlight = useRef(false);
  const timeSynced = useRef(false);
  const wsStatusRef = useRef(wsStatus);
  wsStatusRef.current = wsStatus;
  const contractsRef = useRef(contracts);
  contractsRef.current = contracts;
  const watchedRef = useRef(watched);
  watchedRef.current = watched;
  const socketRef = useRef<PriceStream | null>(null);
  const markAt = useRef<Record<string, number>>({});

  const streamSymbols = useMemo(
    () => [...new Set([...positions.map((p) => p.symbol), ...(watched ? [watched] : [])])],
    [positions, watched],
  );

  const ensureContract = useCallback(
    async (symbol: string) => {
      const cached = contractsRef.current[symbol];
      if (cached) return cached;
      if (!api) throw new ExchangeError('Chưa có API Key');
      const c = await api.getContract(symbol);
      setContracts((prev) => ({ ...prev, [c.symbol]: c }));
      return c;
    },
    [api],
  );

  const refresh = useCallback(async () => {
    if (!api || inFlight.current) return;
    inFlight.current = true;
    try {
      if (!timeSynced.current) {
        await api.syncTime();
        timeSynced.current = true;
      }
      const [account, pos, pending] = await Promise.all([api.getAccount(), api.getOpenPositions(), api.getPendingOrders()]);

      setAsset(keepIfSame(account));
      setPositions(keepIfSame(pos));
      setOrders(keepIfSame(pending));

      const symbols = [
        ...new Set([
          ...pos.map((p) => p.symbol),
          ...pending.map((o) => o.symbol),
          ...(watchedRef.current ? [watchedRef.current] : []),
        ]),
      ];

      // Contract size / precision, fetched once per symbol.
      const missing = symbols.filter((s) => !contractsRef.current[s]);
      if (missing.length) {
        const infos = await Promise.all(missing.map((s) => api.getContract(s).catch(() => null)));
        setContracts((prev) => {
          const next = { ...prev };
          for (const c of infos) if (c) next[c.symbol] = c;
          return next;
        });
      }

      // REST fallback: everything while the socket is down, otherwise only symbols with no recent push.
      const now = Date.now();
      const priced = [
        ...new Set([...pos.map((p) => p.symbol), ...(watchedRef.current ? [watchedRef.current] : [])]),
      ].filter((s) => wsStatusRef.current !== 'open' || now - (markAt.current[s] ?? 0) > MARK_STALE_MS);
      if (priced.length) {
        const prices = await Promise.all(priced.map((s) => api.getFairPrice(s).catch(() => NaN)));
        const at = Date.now();
        setMarks((prev) => {
          let next = prev;
          priced.forEach((s, i) => {
            // A push that arrived meanwhile is newer than this REST answer.
            if (!Number.isFinite(prices[i]) || (markAt.current[s] ?? 0) > now) return;
            markAt.current[s] = at;
            if (next[s] !== prices[i]) next = { ...next, [s]: prices[i] };
          });
          return next;
        });
      }

      setError(null);
      setLastUpdate(Date.now());
    } catch (e) {
      // Timestamp rejections usually mean drift changed: resync on the next poll.
      if (/time|timestamp|recv/i.test(String((e as Error).message))) timeSynced.current = false;
      setError(errorMessage(e));
    } finally {
      inFlight.current = false;
    }
  }, [api]);

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  // Live mark prices (WebSocket, or REST polling where the exchange has no plain-JSON socket).
  useEffect(() => {
    if (!api) return;
    let pending: Record<string, number> = {};
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const batch = pending;
      pending = {};
      setMarks((prev) => {
        let next = prev;
        for (const [symbol, price] of Object.entries(batch)) {
          if (next[symbol] !== price) next = { ...next, [symbol]: price };
        }
        return next;
      });
    };
    const socket = api.createPriceStream(
      (symbol, price) => {
        markAt.current[symbol] = Date.now();
        pending[symbol] = price;
        if (!flushTimer) flushTimer = setTimeout(flush, MARK_FLUSH_MS);
      },
      setWsStatus,
    );
    socketRef.current = socket;
    socket.start();
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      socket.stop();
      socketRef.current = null;
    };
  }, [api]);

  useEffect(() => {
    socketRef.current?.setSymbols(streamSymbols);
  }, [streamSymbols]);

  // A newly watched symbol gets a price right away instead of waiting for the next tick.
  useEffect(() => {
    if (!api || !watched) return;
    api
      .getFairPrice(watched)
      .then((p) => setMarks((prev) => (prev[watched] ? prev : { ...prev, [watched]: p })))
      .catch(() => {});
  }, [api, watched]);

  // Polling, paused while the app is in background.
  useEffect(() => {
    if (!api) return;
    timeSynced.current = false;
    refresh();
    let timer: ReturnType<typeof setInterval> | null = setInterval(refresh, POLL_MS);
    let background = false;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        if (!background) return;
        background = false;
        // The socket may look open but be dead after Doze or a network switch: start fresh,
        // treat every price as stale and resync the clock (drift can change while asleep).
        socketRef.current?.reconnect();
        markAt.current = {};
        timeSynced.current = false;
        refresh();
        if (!timer) timer = setInterval(refresh, POLL_MS);
      } else if (state === 'background') {
        background = true;
        socketRef.current?.stop();
        if (timer) clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      sub.remove();
      if (timer) clearInterval(timer);
    };
  }, [api, refresh]);

  const views = useMemo<PositionView[]>(
    () =>
      positions.map((p) => {
        const mark = marks[p.symbol];
        const contract = contracts[p.symbol];
        if (mark === undefined || !contract) return { ...p, mark, contract };
        return { ...p, mark, contract, ...positionPnl(p, mark, contract) };
      }),
    [positions, marks, contracts],
  );

  const unrealized = useMemo(() => {
    if (!views.length) return 0;
    if (views.every((v) => v.pnl !== undefined)) return views.reduce((s, v) => s + v.pnl!, 0);
    return asset?.unrealized ?? 0;
  }, [views, asset]);

  // ---------- Actions ----------

  /** Market-close `fraction` (0..1] of a position. */
  const closePosition = useCallback(
    async (p: PositionView, fraction = 1) => {
      if (!api) return;
      const c = p.contract;
      let vol = p.holdVol;
      if (fraction < 1 && c) vol = Math.max(floorToUnit(p.holdVol * fraction, c.volUnit, c.volScale), c.minVol);
      // Volume locked by pending close orders would make the close fail: free it first.
      if (p.frozenVol > 0 && vol > p.holdVol - p.frozenVol) await api.cancelAll(p.symbol);
      await api.closePositionMarket(p, p.mark ?? p.holdAvgPrice, Math.min(vol, p.holdVol));
      await refresh();
    },
    [api, refresh],
  );

  /** Sets / replaces / removes (null) the TP and SL of an open position. */
  const setTpSl = useCallback(
    async (p: PositionView, tp: number | null, sl: number | null) => {
      if (!api) return;
      // Fresh orders so an order placed or filled since the last poll is not missed.
      const current = tpslOf(p, await api.getPendingOrders()).orders;
      await api.setPositionTpSl(p, tp, sl, current);
      await refresh();
    },
    [api, refresh],
  );

  const placeOrder = useCallback(
    async (o: NewOrder) => {
      if (!api) throw new ExchangeError('Chưa có API Key');
      const orderId = await api.placeOrder(o);
      await refresh();
      return orderId;
    },
    [api, refresh],
  );

  const cancelOrder = useCallback(
    async (o: PendingOrder) => {
      if (!api) return;
      await api.cancelOrder(o);
      await refresh();
    },
    [api, refresh],
  );

  /** Returns a list of failures (empty = all good). */
  const cancelAll = useCallback(async () => {
    if (!api) return [];
    const errors = await api.cancelAll();
    await refresh();
    return errors;
  }, [api, refresh]);

  /** Panic: cancel every pending order, then market-close every position. */
  const closeAll = useCallback(async () => {
    if (!api) return [];
    const errors = await api.cancelAll().catch((e) => [`Hủy lệnh: ${errorMessage(e)}`]);
    // Use fresh positions: cancelling close orders changes frozenVol.
    const fresh = await api.getOpenPositions();
    errors.push(
      ...(await settle(
        fresh.map((p) => ({
          label: `${api.baseOf(p.symbol)} ${p.positionType === 1 ? 'Long' : 'Short'}`,
          run: () => api.closePositionMarket(p, marks[p.symbol] ?? p.holdAvgPrice),
        })),
      )),
    );
    await refresh();
    return errors;
  }, [api, refresh, marks]);

  return {
    api,
    asset,
    positions: views,
    orders,
    marks,
    contracts,
    unrealized,
    wsStatus,
    error,
    lastUpdate,
    refreshing,
    pullToRefresh,
    watchSymbol: setWatched,
    ensureContract,
    placeOrder,
    closePosition,
    setTpSl,
    cancelOrder,
    cancelAll,
    closeAll,
  };
}
