import type {
  Asset,
  ClosedPosition,
  Candle,
  ContractInfo,
  KlineInterval,
  NewOrder,
  PendingOrder,
  Position,
  Ticker,
} from '../api/types';

export interface FeeRates {
  maker: number;
  taker: number;
}

export type ExchangeId = 'mexc' | 'binance' | 'bingx';

export type StreamStatus = 'connecting' | 'open' | 'closed';

/** Live mark prices for a changing set of symbols. */
export interface PriceStream {
  start(): void;
  stop(): void;
  /** Drop the connection and open a fresh one (e.g. app back in foreground). */
  reconnect(): void;
  setSymbols(symbols: string[]): void;
}

export type OnPrice = (symbol: string, price: number) => void;
export type OnStatus = (status: StreamStatus) => void;

/**
 * One futures exchange (USDT-margined perpetuals). Everything is normalised to the shapes in
 * api/types.ts: volumes are in the exchange's own order unit ("cont" on MEXC, coins on
 * Binance/BingX, where contractSize = 1), sides use MEXC numbering (1 open long, 2 close short,
 * 3 open short, 4 close long).
 */
export interface Exchange {
  readonly id: ExchangeId;
  readonly name: string;
  /** Label for the order unit: "Cont" or "Coin". */
  readonly unitLabel: string;
  readonly defaultSymbols: string[];
  readonly goldSymbol: string;

  now(): number;
  readonly drift: number;
  /** Measures clock drift to the exchange. Returns round-trip latency in ms. */
  syncTime(): Promise<number>;

  /** "BTC", "btcusdt", "BTC_USDT" → this exchange's symbol for the USDT perpetual. */
  normalizeSymbol(input: string): string;
  /** Short display name: "XAU_USDT" / "XAUUSDT" / "XAU-USDT" → "XAU". */
  baseOf(symbol: string): string;

  // Public
  getContract(symbol: string): Promise<ContractInfo>;
  getTicker(symbol: string): Promise<Ticker>;
  getTickers(): Promise<Ticker[]>;
  getFairPrice(symbol: string): Promise<number>;
  getKlines(symbol: string, interval: KlineInterval, count?: number): Promise<Candle[]>;
  /** Base maker/taker fee per symbol, when the exchange publishes it (MEXC). */
  getFeeRates?(): Promise<Record<string, FeeRates>>;

  // Private
  getAccount(): Promise<Asset | null>;
  /** Positions closed between `from` and `to` (ms), newest first. Undefined when unsupported. */
  getClosedPositions?(from: number, to: number): Promise<ClosedPosition[]>;
  getOpenPositions(): Promise<Position[]>;
  getPendingOrders(): Promise<PendingOrder[]>;
  placeOrder(o: NewOrder): Promise<string>;
  /**
   * Sets (or with null removes) the take-profit / stop-loss of an open position. `current` are the
   * position's existing TP/SL orders, which are replaced.
   */
  setPositionTpSl(p: Position, tp: number | null, sl: number | null, current: PendingOrder[]): Promise<void>;
  /** Market-close `vol` (default all) of a position. */
  closePositionMarket(p: Position, price: number, vol?: number): Promise<unknown>;
  cancelOrder(o: PendingOrder): Promise<unknown>;
  /** Cancels every pending order (optionally of one symbol). Returns readable failures. */
  cancelAll(symbol?: string): Promise<string[]>;

  createPriceStream(onPrice: OnPrice, onStatus: OnStatus): PriceStream;
}

export interface ExchangeCredentials {
  exchange: ExchangeId;
  apiKey: string;
  secretKey: string;
  /** MEXC only: api.mexc.com or contract.mexc.com. */
  baseUrl?: string;
  createdAt: number;
}

export const EXCHANGES: { id: ExchangeId; name: string; keyHelp: string }[] = [
  { id: 'mexc', name: 'MEXC', keyHelp: 'MEXC → API Management: quyền đọc + giao dịch Futures (Contract).' },
  { id: 'binance', name: 'Binance', keyHelp: 'Binance → API Management: bật "Enable Futures". Không bật Withdrawals.' },
  { id: 'bingx', name: 'BingX', keyHelp: 'BingX → API Management: quyền Read + Perpetual Futures Trading.' },
];
