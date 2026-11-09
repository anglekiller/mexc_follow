// Shared plumbing for exchange adapters. Plain TypeScript with no React Native imports, so the
// same files are transpiled for the Chrome extension (scripts/sync-extension.js).

import type { KlineInterval } from '../api/types';

/** HMAC-SHA256(secret, message) as lowercase hex. Injected: CryptoJS in the app, WebCrypto in Chrome. */
export type HmacFn = (secret: string, message: string) => Promise<string>;

export class ExchangeError extends Error {
  constructor(
    message: string,
    public code?: number | string,
  ) {
    super(message);
  }
}

export const errorMessage = (e: unknown) =>
  e instanceof ExchangeError && e.code !== undefined
    ? `${e.message} (code ${e.code})`
    : e instanceof Error
      ? e.message
      : String(e);

const TIMEOUT_MS = 10_000;

// Order/position ids beyond Number.MAX_SAFE_INTEGER: quote them before JSON.parse.
const BIG_IDS = /("(?:orderId|id|positionId|stopPlanOrderId|planOrderId|algoId)"\s*:\s*)(\d{16,})/g;

export async function httpJson(url: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text: string;
  let status: number;
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    status = res.status;
    text = await res.text();
  } catch (e) {
    throw new ExchangeError(controller.signal.aborted ? 'Hết thời gian chờ phản hồi (timeout)' : `Lỗi mạng: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  try {
    return { status, json: JSON.parse(text.replace(BIG_IDS, '$1"$2"')) };
  } catch {
    throw new ExchangeError(`HTTP ${status}: phản hồi không hợp lệ`, status);
  }
}

/** "k=v&k=v" in the given key order, values URI-encoded or raw. */
export function queryString(params: Record<string, unknown>, encode: boolean, sort = false) {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== '');
  if (sort) keys.sort();
  return keys.map((k) => `${k}=${encode ? encodeURIComponent(String(params[k])) : String(params[k])}`).join('&');
}

export const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** Decimal places of a step like "0.001" (→ 3) or 1e-5 (→ 5). */
export function decimalsOf(step: string | number) {
  const s = typeof step === 'number' ? step.toFixed(12) : step;
  const t = s.replace(/0+$/, '');
  const dot = t.indexOf('.');
  return dot < 0 ? 0 : t.length - dot - 1;
}

/** Interval names used by Binance and BingX. */
export const STD_INTERVAL: Record<KlineInterval, string> = {
  Min1: '1m',
  Min5: '5m',
  Min15: '15m',
  Min30: '30m',
  Min60: '1h',
  Hour4: '4h',
  Day1: '1d',
  Week1: '1w',
  Month1: '1M',
};

/** Ticker 24h change as a fraction; prefers the absolute change (exchanges round the percentage). */
export function changeRate(last: number, change: number, pct: number) {
  return last - change > 0 ? change / (last - change) : pct / 100;
}
