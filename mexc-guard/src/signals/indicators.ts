import type { Candle } from '../api/types';

/** Exponential moving average of closes; one value per candle (NaN until enough data). */
export function ema(candles: Candle[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = NaN;
  candles.forEach((c, i) => {
    if (i < period - 1) return out.push(NaN);
    if (i === period - 1) prev = candles.slice(0, period).reduce((s, x) => s + x.close, 0) / period;
    else prev = c.close * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

/** Wilder's RSI of the last candle. */
export function rsi(candles: Candle[], period = 14): number {
  if (candles.length <= period) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/** Wilder's Average True Range of the last candle. */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length <= period) return NaN;
  const tr = candles.slice(1).map((c, i) => {
    const prevClose = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  let a = tr.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

export const highest = (candles: Candle[]) => Math.max(...candles.map((c) => c.high));
export const lowest = (candles: Candle[]) => Math.min(...candles.map((c) => c.low));
