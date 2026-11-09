import { BinanceExchange } from './binance';
import { BingxExchange } from './bingx';
import type { HmacFn } from './common';
import { MexcExchange } from './mexc';
import type { Exchange, ExchangeId } from './types';

export * from './common';
export * from './types';
export { MEXC_BASE_URLS } from './mexc';

/** An exchange client; without keys only public market data works. */
export function createExchange(
  id: ExchangeId,
  hmac: HmacFn,
  creds?: { apiKey: string; secretKey: string; baseUrl?: string } | null,
): Exchange {
  const k = creds?.apiKey ?? '';
  const s = creds?.secretKey ?? '';
  if (id === 'binance') return new BinanceExchange(hmac, k, s);
  if (id === 'bingx') return new BingxExchange(hmac, k, s);
  return new MexcExchange(hmac, k, s, creds?.baseUrl || undefined);
}
