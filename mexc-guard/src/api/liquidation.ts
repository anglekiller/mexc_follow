import type { ContractInfo, RiskTier } from './types';

/** Used when the exchange does not publish a maintenance margin rate (Binance/BingX public API). */
export const DEFAULT_MMR = 0.005;

/** Risk tier that a position of `vol` (order units) falls into, if the exchange publishes tiers. */
export function tierFor(c: ContractInfo, vol: number): RiskTier | undefined {
  const tiers = c.riskTiers;
  if (!tiers?.length) return undefined;
  return tiers.find((t) => vol <= t.maxVol) ?? tiers[tiers.length - 1];
}

export function mmrFor(c: ContractInfo, vol: number) {
  return tierFor(c, vol)?.mmr ?? c.maintenanceMarginRate ?? DEFAULT_MMR;
}

export interface LiqInput {
  entry: number;
  /** Position size in base coin (vol × contractSize). */
  qty: number;
  leverage: number;
  mmr: number;
  /** 1 isolated, 2 cross. */
  openType: 1 | 2;
  /** Cross only: free balance before the order (its margin comes out of it). */
  available: number;
}

/**
 * Estimated liquidation prices of a new USDT-margined linear position, before fees and funding.
 * Liquidation happens when the collateral backing the position minus its loss falls to the
 * maintenance margin (qty × price × mmr):
 *  - isolated: the collateral is the order margin, entry × qty / leverage;
 *  - cross: the whole free balance (other positions' PnL ignored).
 * A long that can never be liquidated returns 0.
 */
export function liquidationPrices({ entry, qty, leverage, mmr, openType, available }: LiqInput) {
  if (entry <= 0 || qty <= 0 || leverage <= 0) return null;
  const collateral = openType === 1 ? (entry * qty) / leverage : Math.max(available, 0);
  // Long:  (entry − P)·qty = collateral − qty·P·mmr  →  P = (entry·qty − collateral) / (qty·(1 − mmr))
  // Short: (P − entry)·qty = collateral − qty·P·mmr  →  P = (entry·qty + collateral) / (qty·(1 + mmr))
  const long = Math.max((entry * qty - collateral) / (qty * (1 - mmr)), 0);
  const short = (entry * qty + collateral) / (qty * (1 + mmr));
  return { long, short };
}

/**
 * Highest isolated leverage whose liquidation stays beyond `stop` (with a 10% safety margin on
 * the distance), or null when the stop is on the wrong side.
 */
export function maxLeverageForStop(entry: number, stop: number, mmr: number) {
  if (entry <= 0 || stop <= 0 || stop === entry) return null;
  // From the isolated formulas above with liq = stop, solved for 1/leverage.
  const inv = stop < entry ? 1 - (stop * (1 - mmr)) / entry : (stop * (1 + mmr)) / entry - 1;
  if (inv <= 0) return null;
  return Math.max(Math.floor((1 / inv) * 0.9), 1);
}
