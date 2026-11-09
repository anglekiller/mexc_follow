import type { FeeRates } from '../exchanges/types';

/** 0.0002 → "0.02%", 0 → "0%". */
export function feePct(rate: number) {
  return `${Number((rate * 100).toFixed(4))}%`;
}

export const isZeroFee = (f: FeeRates | undefined) => !!f && f.maker === 0 && f.taker === 0;

/** Short badge: "0 phí", or "0.02%" (taker, the rate a market order pays). */
export const feeBadge = (f: FeeRates) => (isZeroFee(f) ? '0 phí' : feePct(f.taker));
