// Response shapes of MEXC Futures (contract) Open API v1.
// Large ids (orderId, positionId...) are kept as strings to avoid losing precision.

export interface Asset {
  currency: string;
  positionMargin: number;
  availableBalance: number;
  cashBalance: number;
  frozenBalance: number;
  equity: number;
  unrealized: number;
}

export interface Position {
  positionId: string;
  symbol: string;
  positionType: 1 | 2; // 1 long, 2 short
  openType: 1 | 2; // 1 isolated, 2 cross
  state: number;
  holdVol: number;
  frozenVol: number;
  holdAvgPrice: number;
  openAvgPrice: number;
  liquidatePrice: number;
  im: number;
  oim: number;
  leverage: number;
  realised: number;
  createTime: number;
  updateTime: number;
  /** Binance/BingX: "LONG" | "SHORT" | "BOTH", needed to close the position. */
  positionSide?: string;
}

/** A position that has been (fully) closed, for the history screen. */
export interface ClosedPosition {
  id: string;
  symbol: string;
  long: boolean;
  leverage: number;
  openType: 1 | 2;
  /** Closed size in order units (cont on MEXC). */
  vol: number;
  entryPrice: number;
  closePrice: number;
  /** Realised PnL as reported by the exchange (after fees and funding on MEXC). */
  pnl: number;
  /** PnL from price alone, when reported. */
  grossPnl?: number;
  /** Trading fees paid (positive number), when reported. */
  fee?: number;
  /** Funding paid (positive) or received (negative), when reported. */
  funding?: number;
  openTime: number;
  closeTime: number;
}

export interface OpenOrder {
  orderId: string;
  symbol: string;
  price: number;
  vol: number;
  dealVol: number;
  side: number;
  orderType: number;
  leverage: number;
  openType: number;
  createTime: number;
}

export interface PlanOrder {
  id: string;
  symbol: string;
  side: number;
  vol: number;
  price: number;
  triggerPrice: number;
  triggerType: number; // 1 >=, 2 <=
  orderType: number;
  createTime: number;
}

export interface StopOrder {
  id: string;
  symbol: string;
  positionId: string;
  positionType?: number;
  vol?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  createTime: number;
}

export interface ContractInfo {
  symbol: string;
  baseCoin: string;
  contractSize: number;
  priceScale: number;
  priceUnit: number;
  volScale: number;
  volUnit: number;
  minVol: number;
  maxVol: number;
  minLeverage: number;
  maxLeverage: number;
  /** Smallest order value in USDT (Binance/BingX). */
  minNotional?: number;
  /** Trading fee rates as fractions (0.0002 = 0.02%); undefined when the exchange does not say. */
  makerFeeRate?: number;
  takerFeeRate?: number;
  /** Base maintenance margin rate (MEXC). */
  maintenanceMarginRate?: number;
  /** Risk-limit tiers by position volume, ascending (MEXC). */
  riskTiers?: RiskTier[];
}

export interface RiskTier {
  /** Upper bound of the tier, in order units (cont). */
  maxVol: number;
  mmr: number;
  maxLeverage: number;
}

export interface NewOrder {
  symbol: string;
  side: 1 | 3; // open long / open short
  type: 1 | 5; // limit / market
  openType: 1 | 2; // isolated / cross
  price: number;
  vol: number;
  leverage: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  fairPrice: number;
  riseFallRate: number; // 24h change, 0.01 = +1%
  /** Absolute 24h change; riseFallRate is rounded to 4 decimals, too coarse for gold. */
  riseFallValue?: number;
  amount24: number; // 24h turnover (USDT)
  high24Price: number;
  lower24Price: number;
  fundingRate?: number;
}

export interface Candle {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

export type KlineInterval =
  | 'Min1'
  | 'Min5'
  | 'Min15'
  | 'Min30'
  | 'Min60'
  | 'Hour4'
  | 'Day1'
  | 'Week1'
  | 'Month1';

export const INTERVAL_SECONDS: Record<KlineInterval, number> = {
  Min1: 60,
  Min5: 300,
  Min15: 900,
  Min30: 1800,
  Min60: 3600,
  Hour4: 14400,
  Day1: 86400,
  Week1: 604800,
  Month1: 2592000, // ~30 days, only used to size the request window
};

export type PendingKind = 'limit' | 'trigger' | 'tpsl';

/** Unified row for the "Lệnh đang chờ" tab. */
export interface PendingOrder {
  key: string;
  kind: PendingKind;
  id: string;
  symbol: string;
  side?: number;
  typeLabel: string;
  price?: number;
  triggerPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  vol?: number;
  dealVol?: number;
  /** Position a TP/SL order belongs to (MEXC). */
  positionId?: string;
  createTime: number;
}

export const SIDE_LABEL: Record<number, string> = {
  1: 'Mở Long',
  2: 'Đóng Short',
  3: 'Mở Short',
  4: 'Đóng Long',
};

export const ORDER_TYPE_LABEL: Record<number, string> = {
  1: 'Limit',
  2: 'Post Only',
  3: 'IOC',
  4: 'FOK',
  5: 'Market',
  6: 'Market',
};
