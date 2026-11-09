// MEXC Futures (contract) Open API v1.

import type {
  Asset,
  ClosedPosition,
  Candle,
  ContractInfo,
  RiskTier,
  KlineInterval,
  NewOrder,
  OpenOrder,
  PendingOrder,
  PlanOrder,
  Position,
  StopOrder,
  Ticker,
} from '../api/types';
import { ExchangeError, errorMessage, httpJson, queryString, type HmacFn } from './common';
import { mexcStream } from './streams';
import type { Exchange, FeeRates, OnPrice, OnStatus } from './types';

const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

export const MEXC_BASE_URLS = ['https://api.mexc.com', 'https://contract.mexc.com'];

const RECV_WINDOW_SEC = '30';
const SECONDS: Record<KlineInterval, number> = {
  Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Day1: 86400, Week1: 604800, Month1: 2592000,
};
const ORDER_TYPE: Record<number, string> = { 1: 'Limit', 2: 'Post Only', 3: 'IOC', 4: 'FOK', 5: 'Market', 6: 'Market→Limit' };

// Mark a digit string so toJson() emits it as a bare JSON number (no precision loss).
const raw = (digits: string) => `@@${digits}@@`;
const toJson = (value: unknown) => JSON.stringify(value).replace(/"@@(\d+)@@"/g, '$1');

function listOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const list = (data as { resultList?: T[] } | null)?.resultList;
  return Array.isArray(list) ? list : [];
}

type Query = Record<string, string | number | undefined>;

export class MexcExchange implements Exchange {
  readonly id = 'mexc' as const;
  readonly name = 'MEXC';
  readonly unitLabel = 'Cont';
  readonly defaultSymbols = ['XAU_USDT', 'SILVER_USDT', 'BTC_USDT', 'ETH_USDT', 'SOL_USDT'];
  readonly goldSymbol = 'XAU_USDT';
  private timeOffset = 0;

  constructor(
    private readonly hmac: HmacFn,
    private readonly apiKey = '',
    private readonly secretKey = '',
    private readonly baseUrl = MEXC_BASE_URLS[0],
  ) {}

  now() {
    return Date.now() + this.timeOffset;
  }

  get drift() {
    return this.timeOffset;
  }

  async syncTime() {
    const t0 = Date.now();
    const serverTime = await this.request<number>('GET', '/api/v1/contract/ping', { auth: false });
    const t1 = Date.now();
    this.timeOffset = serverTime - Math.round((t0 + t1) / 2);
    return t1 - t0;
  }

  normalizeSymbol(input: string) {
    const s = input.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (s.includes('_')) return s;
    return `${s.endsWith('USDT') ? s.slice(0, -4) : s}_USDT`;
  }

  baseOf(symbol: string) {
    return symbol.replace(/_USDT$/, '');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, opts: { query?: Query; body?: string; auth?: boolean } = {}): Promise<T> {
    const { query, body, auth = true } = opts;
    // GET: params sorted by key. POST: the raw JSON body. Signature = HMAC(apiKey + time + params).
    const qs = queryString(query ?? {}, false, true);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) {
      if (!this.apiKey) throw new ExchangeError('Chưa có API Key');
      const reqTime = String(this.now());
      headers.ApiKey = this.apiKey;
      headers['Request-Time'] = reqTime;
      headers['Recv-Window'] = RECV_WINDOW_SEC;
      headers.Signature = await this.hmac(this.secretKey, this.apiKey + reqTime + (method === 'GET' ? qs : body ?? ''));
    }
    const { status, json } = await httpJson(`${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, { method, headers, body });
    if (!json || typeof json !== 'object') throw new ExchangeError(`HTTP ${status}`, status);
    if (!json.success) throw new ExchangeError(json.message || `Lỗi ${json.code}`, json.code);
    return json.data as T;
  }

  // ---------- Public ----------

  async getContract(symbol: string): Promise<ContractInfo> {
    const d = await this.request<any>('GET', '/api/v1/contract/detail', { query: { symbol }, auth: false });
    if (!d || !d.symbol) throw new ExchangeError(`Không tìm thấy hợp đồng ${symbol}`);
    return {
      symbol: d.symbol,
      baseCoin: d.baseCoin,
      contractSize: d.contractSize,
      priceScale: d.priceScale,
      priceUnit: d.priceUnit,
      volScale: d.volScale,
      volUnit: d.volUnit,
      minVol: d.minVol,
      maxVol: d.maxVol,
      minLeverage: d.minLeverage,
      maxLeverage: d.maxLeverage,
      makerFeeRate: num(d.makerFeeRate),
      takerFeeRate: num(d.takerFeeRate),
      maintenanceMarginRate: d.maintenanceMarginRate,
      riskTiers: Array.isArray(d.riskLimitCustom)
        ? d.riskLimitCustom
            .map((t: any) => ({ maxVol: Number(t.maxVol), mmr: Number(t.mmr), maxLeverage: Number(t.maxLeverage) }))
            .filter((t: RiskTier) => t.maxVol > 0 && Number.isFinite(t.mmr))
            .sort((a: RiskTier, b: RiskTier) => a.maxVol - b.maxVol)
        : undefined,
    };
  }

  private feeCache: { at: number; rates: Record<string, FeeRates> } | null = null;

  /** Fee rates of every USDT perpetual from the public contract list (cached 5 min). */
  async getFeeRates() {
    if (this.feeCache && Date.now() - this.feeCache.at < 5 * 60_000) return this.feeCache.rates;
    const all = await this.request<any[]>('GET', '/api/v1/contract/detail', { auth: false });
    const rates: Record<string, FeeRates> = {};
    for (const d of all) {
      const maker = num(d.makerFeeRate);
      const taker = num(d.takerFeeRate);
      if (d.symbol?.endsWith('_USDT') && maker !== undefined && taker !== undefined) rates[d.symbol] = { maker, taker };
    }
    this.feeCache = { at: Date.now(), rates };
    return rates;
  }

  getTicker(symbol: string) {
    return this.request<Ticker>('GET', '/api/v1/contract/ticker', { query: { symbol }, auth: false });
  }

  async getTickers() {
    const all = await this.request<Ticker[]>('GET', '/api/v1/contract/ticker', { auth: false });
    return all.filter((t) => t.symbol.endsWith('_USDT'));
  }

  async getFairPrice(symbol: string) {
    return (await this.getTicker(symbol)).fairPrice;
  }

  async getKlines(symbol: string, interval: KlineInterval, count = 300): Promise<Candle[]> {
    const end = Math.floor(this.now() / 1000);
    const d = await this.request<{ time: number[]; open: number[]; high: number[]; low: number[]; close: number[]; vol: number[] }>(
      'GET',
      `/api/v1/contract/kline/${symbol}`,
      { query: { interval, start: end - SECONDS[interval] * count, end }, auth: false },
    );
    return d.time.map((t, i) => ({ time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i], vol: d.vol[i] }));
  }

  // ---------- Private ----------

  async getAccount(): Promise<Asset | null> {
    const assets = await this.request<Asset[]>('GET', '/api/v1/private/account/assets');
    return assets.find((a) => a.currency === 'USDT') ?? null;
  }

  async getOpenPositions(): Promise<Position[]> {
    return listOf<Position>(await this.request('GET', '/api/v1/private/position/open_positions'));
  }

  /**
   * Closed positions from history_positions (newest first, paginated). Pages are read until they
   * go past `from`; MEXC only keeps a limited window of history.
   */
  async getClosedPositions(from: number, to: number): Promise<ClosedPosition[]> {
    const PAGE = 100;
    const out: ClosedPosition[] = [];
    for (let page = 1; page <= 30; page++) {
      const rows = listOf<any>(
        await this.request('GET', '/api/v1/private/position/list/history_positions', { query: { page_num: page, page_size: PAGE } }),
      );
      for (const r of rows) {
        const closeTime = num(r.updateTime) ?? 0;
        if (closeTime < from || closeTime > to) continue;
        const fee = num(r.totalFee) ?? num(r.fee);
        out.push({
          id: String(r.positionId),
          symbol: r.symbol,
          long: Number(r.positionType) === 1,
          leverage: num(r.leverage) ?? 0,
          openType: Number(r.openType) === 2 ? 2 : 1,
          vol: num(r.closeVol) || num(r.holdVol) || 0,
          entryPrice: num(r.openAvgPrice) || num(r.holdAvgPrice) || 0,
          closePrice: num(r.closeAvgPrice) ?? 0,
          pnl: num(r.realised) ?? 0,
          grossPnl: num(r.closeProfitLoss),
          fee: fee === undefined ? undefined : Math.abs(fee),
          funding: num(r.holdFee) === undefined ? undefined : -num(r.holdFee)!,
          openTime: num(r.createTime) ?? 0,
          closeTime,
        });
      }
      const oldest = num(rows[rows.length - 1]?.updateTime) ?? 0;
      if (rows.length < PAGE || oldest < from) break;
    }
    return out.sort((a, b) => b.closeTime - a.closeTime);
  }

  async getPendingOrders(): Promise<PendingOrder[]> {
    const page = { page_num: 1, page_size: 100 };
    const [open, plan, stop] = await Promise.all([
      this.request('GET', '/api/v1/private/order/list/open_orders', { query: page }).then((d) => listOf<OpenOrder>(d)),
      this.request('GET', '/api/v1/private/planorder/list/orders', { query: { ...page, states: 1 } }).then((d) => listOf<PlanOrder>(d)),
      this.request('GET', '/api/v1/private/stoporder/list/orders', { query: { ...page, is_finished: 0 } }).then((d) => listOf<StopOrder>(d)),
    ]);
    return [
      ...open.map<PendingOrder>((o) => ({
        key: `l${o.orderId}`,
        kind: 'limit',
        id: o.orderId,
        symbol: o.symbol,
        side: o.side,
        typeLabel: ORDER_TYPE[o.orderType] ?? `Type ${o.orderType}`,
        price: o.price,
        vol: o.vol,
        dealVol: o.dealVol,
        createTime: o.createTime,
      })),
      ...plan.map<PendingOrder>((o) => ({
        key: `p${o.id}`,
        kind: 'trigger',
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        typeLabel: o.orderType === 5 ? 'Trigger Market' : 'Trigger Limit',
        price: o.orderType === 5 ? undefined : o.price,
        triggerPrice: o.triggerPrice,
        vol: o.vol,
        dealVol: 0,
        createTime: o.createTime,
      })),
      ...stop.map<PendingOrder>((o) => ({
        key: `s${o.id}`,
        kind: 'tpsl',
        id: o.id,
        symbol: o.symbol,
        typeLabel: 'TP/SL',
        side: o.positionType === 1 ? 4 : o.positionType === 2 ? 2 : undefined,
        positionId: o.positionId ? String(o.positionId) : undefined,
        takeProfitPrice: o.takeProfitPrice || undefined,
        stopLossPrice: o.stopLossPrice || undefined,
        vol: o.vol,
        createTime: o.createTime,
      })),
    ].sort((a, b) => b.createTime - a.createTime);
  }

  async placeOrder(o: NewOrder) {
    return String(await this.request<string>('POST', '/api/v1/private/order/submit', { body: toJson(o) }));
  }

  /**
   * MEXC keeps one TP/SL order per position holding both prices. An existing one is re-priced
   * (documented change_plan_price); removing a leg or creating one goes through stoporder/place,
   * the endpoint the MEXC web app uses. A new order is placed before the old one is cancelled so
   * the position is never left without its stop.
   */
  async setPositionTpSl(p: Position, tp: number | null, sl: number | null, current: PendingOrder[]) {
    const old = current.find((o) => o.kind === 'tpsl');
    if (tp === null && sl === null) {
      if (old) await this.cancelOrder(old);
      return;
    }
    const keepsLegs = !!old && (tp !== null) === !!old.takeProfitPrice && (sl !== null) === !!old.stopLossPrice;
    if (old && keepsLegs) {
      await this.request('POST', '/api/v1/private/stoporder/change_plan_price', {
        body: toJson({
          stopPlanOrderId: raw(old.id),
          ...(tp !== null && { takeProfitPrice: tp }),
          ...(sl !== null && { stopLossPrice: sl }),
        }),
      });
      return;
    }
    await this.request('POST', '/api/v1/private/stoporder/place', {
      body: toJson({
        positionId: raw(p.positionId),
        vol: p.holdVol,
        ...(tp !== null && { takeProfitPrice: tp, profitTrend: 1 }),
        ...(sl !== null && { stopLossPrice: sl, lossTrend: 1 }),
        priceProtect: 0,
        profitLossVolType: 'SAME',
        volType: 2,
      }),
    });
    if (old) await this.cancelOrder(old).catch(() => {});
  }

  closePositionMarket(p: Position, price: number, vol = p.holdVol) {
    const body = toJson({
      symbol: p.symbol,
      price,
      vol,
      leverage: p.leverage,
      side: p.positionType === 1 ? 4 : 2,
      type: 5,
      openType: p.openType,
      positionId: raw(p.positionId),
    });
    return this.request('POST', '/api/v1/private/order/submit', { body });
  }

  cancelOrder(o: PendingOrder) {
    if (o.kind === 'limit') return this.request('POST', '/api/v1/private/order/cancel', { body: toJson([raw(o.id)]) });
    if (o.kind === 'trigger')
      return this.request('POST', '/api/v1/private/planorder/cancel', { body: toJson([{ symbol: o.symbol, orderId: raw(o.id) }]) });
    return this.request('POST', '/api/v1/private/stoporder/cancel', { body: toJson([{ stopPlanOrderId: raw(o.id) }]) });
  }

  async cancelAll(symbol?: string) {
    const tasks: [string, () => Promise<unknown>][] = [
      ['Lệnh Limit', () => this.request('POST', '/api/v1/private/order/cancel_all', { body: toJson(symbol ? { symbol } : {}) })],
      ['Lệnh Trigger', () => this.request('POST', '/api/v1/private/planorder/cancel_all', { body: toJson(symbol ? { symbol } : {}) })],
      ['Lệnh TP/SL', () => this.request('POST', '/api/v1/private/stoporder/cancel_all', { body: toJson(symbol ? { symbol } : {}) })],
    ];
    const res = await Promise.allSettled(tasks.map(([, run]) => run()));
    return res.flatMap((r, i) => (r.status === 'rejected' ? [`${tasks[i][0]}: ${errorMessage(r.reason)}`] : []));
  }

  createPriceStream(onPrice: OnPrice, onStatus: OnStatus) {
    return mexcStream(onPrice, onStatus);
  }
}
