import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import type { Exchange } from '../exchanges';
import type { Candle, KlineInterval, Ticker } from '../api/types';

const POLL_MS = 5_000;

// Survives tab switches (the screen unmounts), so the chart can paint before the first response.
const CACHE_SIZE = 12;
const cache = new Map<string, { candles: Candle[]; ticker: Ticker }>();

function remember(key: string, candles: Candle[], ticker: Ticker) {
  cache.delete(key);
  cache.set(key, { candles, ticker });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/**
 * Candles + 24h ticker for one symbol, polled every 5s. The last candle follows the
 * live mark price between polls so the chart moves in real time.
 */
export function useKlines(api: Exchange | null, symbol: string, interval: KlineInterval, livePrice?: number) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const key = `${api.name}|${symbol}|${interval}`;
    const cached = cache.get(key);
    setCandles(cached?.candles ?? []);
    setTicker(cached?.ticker ?? null);
    setLoading(!cached);

    const load = () =>
      Promise.all([api.getKlines(symbol, interval), api.getTicker(symbol)])
        .then(([c, t]) => {
          remember(key, c, t);
          if (!alive) return;
          setCandles(c);
          setTicker(t);
        })
        .catch(() => {})
        .finally(() => alive && setLoading(false));

    load();
    let timer: ReturnType<typeof setInterval> | null = setInterval(load, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && !timer) {
        load();
        timer = setInterval(load, POLL_MS);
      } else if (s !== 'active' && timer) {
        clearInterval(timer);
        timer = null;
      }
    });
    return () => {
      alive = false;
      sub.remove();
      if (timer) clearInterval(timer);
    };
  }, [api, symbol, interval]);

  const live = useMemo(() => {
    if (!candles.length || livePrice === undefined) return candles;
    const last = candles[candles.length - 1];
    return [
      ...candles.slice(0, -1),
      { ...last, close: livePrice, high: Math.max(last.high, livePrice), low: Math.min(last.low, livePrice) },
    ];
  }, [candles, livePrice]);

  return { candles: live, ticker, loading };
}
