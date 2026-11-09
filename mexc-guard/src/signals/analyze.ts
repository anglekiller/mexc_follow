import type { Candle } from '../api/types';
import type { Exchange } from '../exchanges';
import { atr, ema, highest, lowest, rsi } from './indicators';
import { symbolFor, type Instrument } from './instruments';

export type Trend = 'up' | 'down' | 'flat';

/** A rule-based entry idea with an ATR-based plan. */
export interface Setup {
  kind: 'pullback' | 'breakout' | 'extended';
  side: 'long' | 'short';
  title: string;
  reason: string;
  /** Absent for "extended" (a caution, not an entry). */
  plan?: { entry: number; sl: number; tp1: number; tp2: number };
}

export interface MarketView {
  inst: Instrument;
  symbol: string;
  price: number;
  change24: number;
  trendH4: Trend;
  ema20H4: number;
  ema50H4: number;
  ema20H1: number;
  ema50H1: number;
  rsiH1: number;
  atrH1: number;
  high24: number;
  low24: number;
  /** H4 range of the last ~5 days. */
  support: number;
  resistance: number;
  setup: Setup | null;
  /** Last 24 closed H1 candles, for the AI prompt. */
  recentH1: Candle[];
  time: number;
}

const last = <T,>(a: T[]) => a[a.length - 1];

function detect(view: Omit<MarketView, 'setup'>, closed: Candle[]): Setup | null {
  const { price, trendH4, ema20H1, rsiH1, atrH1: a } = view;
  if (!(a > 0)) return null;
  const c = last(closed);
  const prior = closed.slice(-25, -1);
  const plan = (side: 'long' | 'short', sl: number) => {
    const dir = side === 'long' ? 1 : -1;
    // Stop at least 1 ATR away; targets at 1.5R and 2.5R.
    const stop = side === 'long' ? Math.min(sl, price - a) : Math.max(sl, price + a);
    const r = Math.abs(price - stop);
    return { entry: price, sl: stop, tp1: price + dir * 1.5 * r, tp2: price + dir * 2.5 * r };
  };

  // 1. Fresh breakout of the 24h range, not against the H4 trend.
  const top = highest(prior);
  const bottom = lowest(prior);
  if (c.close > top && c.close - top < a && trendH4 !== 'down') {
    return {
      kind: 'breakout',
      side: 'long',
      title: 'Phá đỉnh 24h — canh Long',
      reason: `Nến H1 đóng trên đỉnh 24h (${top}). Xu hướng H4 ${trendH4 === 'up' ? 'tăng' : 'đi ngang'}.`,
      plan: plan('long', top - 0.5 * a),
    };
  }
  if (c.close < bottom && bottom - c.close < a && trendH4 !== 'up') {
    return {
      kind: 'breakout',
      side: 'short',
      title: 'Thủng đáy 24h — canh Short',
      reason: `Nến H1 đóng dưới đáy 24h (${bottom}). Xu hướng H4 ${trendH4 === 'down' ? 'giảm' : 'đi ngang'}.`,
      plan: plan('short', bottom + 0.5 * a),
    };
  }

  // 2. Pullback to the H1 EMA20 that held, in the direction of the H4 trend.
  const swingLow = lowest(closed.slice(-5));
  const swingHigh = highest(closed.slice(-5));
  if (trendH4 === 'up' && c.low <= ema20H1 + 0.3 * a && c.close > ema20H1 && rsiH1 >= 38 && rsiH1 <= 58) {
    return {
      kind: 'pullback',
      side: 'long',
      title: 'Hồi về EMA20 trong xu hướng tăng — canh Long',
      reason: `H4 tăng (EMA20 > EMA50). Giá H1 chạm EMA20 rồi đóng lại phía trên, RSI ${rsiH1.toFixed(0)} chưa quá mua.`,
      plan: plan('long', swingLow - 0.3 * a),
    };
  }
  if (trendH4 === 'down' && c.high >= ema20H1 - 0.3 * a && c.close < ema20H1 && rsiH1 >= 42 && rsiH1 <= 62) {
    return {
      kind: 'pullback',
      side: 'short',
      title: 'Hồi lên EMA20 trong xu hướng giảm — canh Short',
      reason: `H4 giảm (EMA20 < EMA50). Giá H1 chạm EMA20 rồi đóng lại phía dưới, RSI ${rsiH1.toFixed(0)} chưa quá bán.`,
      plan: plan('short', swingHigh + 0.3 * a),
    };
  }

  // 3. Stretched: a caution, not an entry.
  if (rsiH1 >= 75)
    return {
      kind: 'extended',
      side: 'short',
      title: 'Quá mua — tránh đuổi Long',
      reason: `RSI H1 ${rsiH1.toFixed(0)}. Dễ có nhịp điều chỉnh; chờ giá hồi về EMA20 (${ema20H1.toFixed(2)}) hoặc tín hiệu đảo chiều.`,
    };
  if (rsiH1 <= 25)
    return {
      kind: 'extended',
      side: 'long',
      title: 'Quá bán — tránh đuổi Short',
      reason: `RSI H1 ${rsiH1.toFixed(0)}. Dễ có nhịp hồi; chờ giá hồi về EMA20 (${ema20H1.toFixed(2)}) hoặc tín hiệu đảo chiều.`,
    };
  return null;
}

/** Fetches H1 / H4 candles of an instrument and computes its view and current setup. */
export async function analyze(api: Exchange, inst: Instrument): Promise<MarketView | null> {
  const symbol = symbolFor(api.id, inst.id);
  if (!symbol) return null;
  const [h1, h4] = await Promise.all([api.getKlines(symbol, 'Min60', 120), api.getKlines(symbol, 'Hour4', 80)]);
  if (h1.length < 60 || h4.length < 55) throw new Error(`Không đủ dữ liệu nến ${inst.name}`);

  // Indicators on closed candles; the price from the forming one.
  const closedH1 = h1.slice(0, -1);
  const closedH4 = h4.slice(0, -1);
  const price = last(h1).close;
  const e20h4 = last(ema(closedH4, 20));
  const e50h4 = last(ema(closedH4, 50));
  const lastH4 = last(closedH4).close;
  const trendH4: Trend = e20h4 > e50h4 && lastH4 > e50h4 ? 'up' : e20h4 < e50h4 && lastH4 < e50h4 ? 'down' : 'flat';
  const day = closedH1.slice(-24);
  const base: Omit<MarketView, 'setup'> = {
    inst,
    symbol,
    price,
    change24: ((price - day[0].open) / day[0].open) * 100,
    trendH4,
    ema20H4: e20h4,
    ema50H4: e50h4,
    ema20H1: last(ema(closedH1, 20)),
    ema50H1: last(ema(closedH1, 50)),
    rsiH1: rsi(closedH1),
    atrH1: atr(closedH1),
    high24: highest(day),
    low24: lowest(day),
    support: lowest(closedH4.slice(-30)),
    resistance: highest(closedH4.slice(-30)),
    recentH1: day,
    time: Date.now(),
  };
  return { ...base, setup: detect(base, closedH1) };
}
