import type { ExchangeId } from '../exchanges';

export type InstrumentId = 'gold' | 'silver' | 'oil';

export interface Instrument {
  id: InstrumentId;
  name: string;
  /** Short code for notifications. */
  code: string;
  icon: string;
}

export const INSTRUMENTS: Instrument[] = [
  { id: 'gold', name: 'Vàng', code: 'XAU', icon: '🥇' },
  { id: 'silver', name: 'Bạc', code: 'XAG', icon: '🥈' },
  { id: 'oil', name: 'Dầu WTI', code: 'WTI', icon: '🛢️' },
];

/** The USDT perpetual of each instrument per exchange (null: not listed there). */
const SYMBOLS: Record<ExchangeId, Record<InstrumentId, string | null>> = {
  mexc: { gold: 'XAU_USDT', silver: 'SILVER_USDT', oil: 'USOIL_USDT' },
  binance: { gold: 'XAUUSDT', silver: 'XAGUSDT', oil: null },
  bingx: { gold: 'NCCOGOLD2USD-USDT', silver: 'NCCOXAG2USD-USDT', oil: 'NCCO1OILWTI2USD-USDT' },
};

export const symbolFor = (ex: ExchangeId, id: InstrumentId) => SYMBOLS[ex][id];
