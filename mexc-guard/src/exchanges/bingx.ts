// BingX USDT-M perpetual swap (openApi/swap). Quantities are in coins (contractSize = 1).
// Signed requests: HMAC-SHA256 over the key-sorted, unencoded "k=v&…" string (incl. timestamp),
// sent URL-encoded with &signature=…; header X-BX-APIKEY. The market socket is gzip-only, so mark
// prices are polled over REST.

import type { Asset, Candle, ContractInfo, KlineInterval, NewOrder, PendingOrder, Position, Ticker } from '../api/types';
import { changeRate, ExchangeError, errorMessage, httpJson, num, queryString, STD_INTERVAL, type HmacFn } from './common';
import { pollingStream } from './streams';
import type { Exchange, OnPrice, OnStatus } from './types';

const BASE = 'https://open-api.bingx.com/openApi';
const DUAL_TTL_MS = 60_000;

type Params = Record<string, string | number | boolean | undefined>;

function sideNum(side: string, positionSide: string, reduceOnly?: boolean) {
  if (positionSide === 'LONG') return side === 'BUY' ? 1 : 4;
  if (positionSide === 'SHORT') return side === 'SELL' ? 3 : 2;
  if (side === 'BUY') return reduceOnly ? 2 : 1;
  return reduceOnly ? 4 : 3;
}

export class BingxExchange implements Exchange {
  readonly id = 'bingx' as const;
  readonly name = 'BingX';
  readonly unitLabel = 'Coin';
  readonly defaultSymbols = ['NCCOGOLD2USD-USDT', 'XAUT-USDT', 'BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
  readonly goldSymbol = 'NCCOGOLD2USD-USDT';
  private timeOffset = 0;
  private contracts: Promise<Map<string, any>> | null = null;
  private maxLev = new Map<string, number>();
  private dual: { at: number; value: boolean } | null = null;

  constructor(
    private readonly hmac: HmacFn,
    private readonly apiKey = '',
    private readonly secretKey = '',
  ) {}

  now() {
    return Date.now() + this.timeOffset;
  }

  get drift() {
    return this.timeOffset;
  }

  async syncTime() {
    const t0 = Date.now();
    const d = await this.request('GET', '/swap/v2/server/time', {}, false);
    const t1 = Date.now();
    this.timeOffset = num(d.serverTime) - Math.round((t0 + t1) / 2);
    return t1 - t0;
  }

  normalizeSymbol(input: string) {
    const s = input.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/_/g, '-');
    if (s.includes('-')) return s;
    return `${s.endsWith('USDT') ? s.slice(0, -4) : s}-USDT`;
  }

  /** "BTC-USDT" → "BTC"; BingX TradFi names like "NCCOGOLD2USD-USDT" → "GOLD". */
  baseOf(symbol: string) {
    return symbol.replace(/-USDT$/, '').replace(/^NC(?:CO|FX|SK)(.+?)2USD$/, '$1');
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}, signed = true): Promise<any> {
    let url = `${BASE}${path}`;
    const headers: Record<string, string> = {};
    if (signed) {
      if (!this.apiKey) throw new ExchangeError('Chưa có API Key');
      const p = { ...params, timestamp: this.now() };
      const signature = await this.hmac(this.secretKey, queryString(p, false, true));
      url += `?${queryString(p, true, true)}&signature=${signature}`;
      headers['X-BX-APIKEY'] = this.apiKey;
    } else {
      const qs = queryString(params, true);
      if (qs) url += `?${qs}`;
    }
    const { status, json } = await httpJson(url, { method, headers });
    if (!json || typeof json !== 'object') throw new ExchangeError(`HTTP ${status}`, status);
    if (json.code !== 0 && json.code !== '0') throw new ExchangeError(json.msg || `Lỗi ${json.code}`, json.code);
    return json.data;
  }

  // ---------- Public ----------

  private contractMap() {
    if (!this.contracts) {
      this.contracts = this.request('GET', '/swap/v2/quote/contracts', {}, false)
        .then((rows: any[]) => {
          const map = new Map<string, any>();
          for (const c of rows) if (c.currency === 'USDT' && Number(c.status) === 1) map.set(c.symbol, c);
          return map;
        })
        .catch((e) => {
          this.contracts = null;
          throw e;
        });
    }
    return this.contracts;
  }

  async getContract(symbol: string): Promise<ContractInfo> {
    const c = (await this.contractMap()).get(symbol);
    if (!c) throw new ExchangeError(`Không tìm thấy hợp đồng ${symbol}`);
    const qp = num(c.quantityPrecision);
    const pp = num(c.pricePrecision);
    return {
      symbol,
      baseCoin: c.asset,
      contractSize: 1,
      priceScale: pp,
      priceUnit: 10 ** -pp,
      volScale: qp,
      volUnit: 10 ** -qp,
      minVol: num(c.tradeMinQuantity) || 10 ** -qp,
      maxVol: Infinity,
      minLeverage: 1,
      maxLeverage: await this.maxLeverage(symbol),
      minNotional: num(c.tradeMinUSDT) || undefined,
    };
  }

  private async maxLeverage(symbol: string) {
    const cached = this.maxLev.get(symbol);
    if (cached) return cached;
    if (!this.apiKey) return 125;
    try {
      const d = await this.request('GET', '/swap/v2/trade/leverage', { symbol });
      const lev = Math.max(num(d.maxLongLeverage), num(d.maxShortLeverage)) || 125;
      this.maxLev.set(symbol, lev);
      return lev;
    } catch {
      return 125;
    }
  }

  private ticker(t: any, mark?: number, funding?: number): Ticker {
    const last = num(t.lastPrice);
    return {
      symbol: t.symbol,
      lastPrice: last,
      fairPrice: mark || last,
      riseFallValue: num(t.priceChange),
      riseFallRate: changeRate(last, num(t.priceChange), num(t.priceChangePercent)),
      amount24: num(t.quoteVolume),
      high24Price: num(t.highPrice),
      lower24Price: num(t.lowPrice),
      fundingRate: funding,
    };
  }

  async getTicker(symbol: string) {
    const [t, p] = await Promise.all([
      this.request('GET', '/swap/v2/quote/ticker', { symbol }, false),
      this.request('GET', '/swap/v2/quote/premiumIndex', { symbol }, false),
    ]);
    return this.ticker(t, num(p.markPrice), num(p.lastFundingRate));
  }

  async getTickers() {
    const [all, map] = await Promise.all([this.request('GET', '/swap/v2/quote/ticker', {}, false), this.contractMap()]);
    return (all as any[]).filter((t) => map.has(t.symbol)).map((t) => this.ticker(t));
  }

  async getFairPrice(symbol: string) {
    return num((await this.request('GET', '/swap/v2/quote/premiumIndex', { symbol }, false)).markPrice);
  }

  async getKlines(symbol: string, interval: KlineInterval, count = 300): Promise<Candle[]> {
    const rows = await this.request('GET', '/swap/v3/quote/klines', { symbol, interval: STD_INTERVAL[interval], limit: Math.min(count, 1440) }, false);
    return (rows as any[])
      .map((r) => ({
        time: Math.floor(num(r.time) / 1000),
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        close: num(r.close),
        vol: num(r.volume),
      }))
      .sort((a, b) => a.time - b.time);
  }

  // ---------- Private ----------

  private async isDual() {
    if (this.dual && Date.now() - this.dual.at < DUAL_TTL_MS) return this.dual.value;
    let value = true; // BingX accounts default to hedge mode
    try {
      const d = await this.request('GET', '/swap/v1/positionSide/dual');
      value = String(d?.dualSidePosition) !== 'false';
    } catch {
      // older accounts/endpoints: assume hedge mode
    }
    this.dual = { at: Date.now(), value };
    return value;
  }

  async getAccount(): Promise<Asset | null> {
    const d = await this.request('GET', '/swap/v3/user/balance');
    const rows: any[] = Array.isArray(d) ? d : d?.balance ? [d.balance] : [];
    const b = rows.find((x) => x.asset === 'USDT');
    if (!b) return null;
    return {
      currency: 'USDT',
      equity: num(b.equity),
      availableBalance: num(b.availableMargin),
      positionMargin: num(b.usedMargin),
      cashBalance: num(b.balance),
      frozenBalance: num(b.freezedMargin),
      unrealized: num(b.unrealizedProfit),
    };
  }

  async getOpenPositions(): Promise<Position[]> {
    const rows: any[] = (await this.request('GET', '/swap/v2/user/positions')) ?? [];
    return rows
      .filter((r) => num(r.positionAmt) !== 0)
      .map<Position>((r) => {
        const amt = num(r.positionAmt);
        const isolated = r.isolated === true || r.isolated === 'true';
        return {
          positionId: String(r.positionId ?? `${r.symbol}:${r.positionSide}`),
          symbol: r.symbol,
          positionType: r.positionSide === 'SHORT' || (r.positionSide !== 'LONG' && amt < 0) ? 2 : 1,
          openType: isolated ? 1 : 2,
          state: 1,
          holdVol: Math.abs(amt),
          frozenVol: 0,
          holdAvgPrice: num(r.avgPrice),
          openAvgPrice: num(r.avgPrice),
          liquidatePrice: num(r.liquidationPrice),
          im: num(r.initialMargin) || num(r.margin),
          oim: 0,
          leverage: num(r.leverage) || 1,
          realised: num(r.realisedProfit),
          createTime: num(r.createTime),
          updateTime: num(r.updateTime),
          positionSide: r.positionSide,
        };
      });
  }

  async getPendingOrders(): Promise<PendingOrder[]> {
    const d = await this.request('GET', '/swap/v2/trade/openOrders');
    const rows: any[] = d?.orders ?? (Array.isArray(d) ? d : []);
    return rows
      .map<PendingOrder>((o) => {
        const type = String(o.type);
        const stop = num(o.stopPrice);
        const tpsl = /^(TAKE_PROFIT|STOP)/.test(type);
        const isTp = /TAKE_PROFIT/.test(type);
        return {
          key: `l${o.orderId}`,
          kind: type === 'LIMIT' ? 'limit' : tpsl ? 'tpsl' : 'trigger',
          id: String(o.orderId),
          symbol: o.symbol,
          side: sideNum(o.side, o.positionSide, o.reduceOnly === true || tpsl),
          typeLabel: type === 'LIMIT' ? 'Limit' : tpsl ? (isTp ? 'Chốt lời (TP)' : 'Cắt lỗ (SL)') : type.replace(/_/g, ' '),
          price: num(o.price) || undefined,
          triggerPrice: !tpsl && stop ? stop : undefined,
          takeProfitPrice: tpsl && isTp ? stop : undefined,
          stopLossPrice: tpsl && !isTp ? stop : undefined,
          vol: num(o.origQty) || undefined,
          dealVol: num(o.executedQty),
          createTime: num(o.time ?? o.updateTime),
        };
      })
      .sort((a, b) => b.createTime - a.createTime);
  }

  async placeOrder(o: NewOrder) {
    const [c, dual] = await Promise.all([this.getContract(o.symbol), this.isDual()]);
    const long = o.side === 1;
    const positionSide = dual ? (long ? 'LONG' : 'SHORT') : 'BOTH';

    const marginType = o.openType === 1 ? 'ISOLATED' : 'CROSSED';
    const current = await this.request('GET', '/swap/v2/trade/marginType', { symbol: o.symbol }).catch(() => null);
    if (current?.marginType !== marginType) await this.request('POST', '/swap/v2/trade/marginType', { symbol: o.symbol, marginType });
    await this.request('POST', '/swap/v2/trade/leverage', { symbol: o.symbol, side: positionSide, leverage: o.leverage });

    const leg = (type: string, price: number) =>
      JSON.stringify({ type, stopPrice: Number(price.toFixed(c.priceScale)), price: Number(price.toFixed(c.priceScale)), workingType: 'MARK_PRICE' });
    const d = await this.request('POST', '/swap/v2/trade/order', {
      symbol: o.symbol,
      side: long ? 'BUY' : 'SELL',
      positionSide,
      type: o.type === 1 ? 'LIMIT' : 'MARKET',
      price: o.type === 1 ? o.price.toFixed(c.priceScale) : undefined,
      quantity: o.vol.toFixed(c.volScale),
      takeProfit: o.takeProfitPrice ? leg('TAKE_PROFIT_MARKET', o.takeProfitPrice) : undefined,
      stopLoss: o.stopLossPrice ? leg('STOP_MARKET', o.stopLossPrice) : undefined,
    });
    return String(d?.order?.orderId ?? d?.orderId ?? '');
  }

  /** TP/SL as close-position stop orders on the mark price; a changed leg is cancelled then re-placed. */
  async setPositionTpSl(p: Position, tp: number | null, sl: number | null, current: PendingOrder[]) {
    const c = await this.getContract(p.symbol);
    const legs = [
      { want: tp, type: 'TAKE_PROFIT_MARKET', old: current.find((o) => o.takeProfitPrice !== undefined), oldPrice: (o: PendingOrder) => o.takeProfitPrice },
      { want: sl, type: 'STOP_MARKET', old: current.find((o) => o.stopLossPrice !== undefined), oldPrice: (o: PendingOrder) => o.stopLossPrice },
    ];
    for (const leg of legs) {
      if (leg.old && leg.want !== null && leg.oldPrice(leg.old) === leg.want) continue;
      if (leg.old) await this.cancelOrder(leg.old);
      if (leg.want === null) continue;
      await this.request('POST', '/swap/v2/trade/order', {
        symbol: p.symbol,
        side: p.positionType === 1 ? 'SELL' : 'BUY',
        positionSide: p.positionSide || 'BOTH',
        type: leg.type,
        stopPrice: leg.want.toFixed(c.priceScale),
        closePosition: 'true',
        workingType: 'MARK_PRICE',
      });
    }
  }

  async closePositionMarket(p: Position, _price: number, vol = p.holdVol) {
    const c = await this.getContract(p.symbol);
    const oneWay = !p.positionSide || p.positionSide === 'BOTH';
    return this.request('POST', '/swap/v2/trade/order', {
      symbol: p.symbol,
      side: p.positionType === 1 ? 'SELL' : 'BUY',
      positionSide: p.positionSide || 'BOTH',
      reduceOnly: oneWay ? 'true' : undefined,
      type: 'MARKET',
      quantity: vol.toFixed(c.volScale),
    });
  }

  cancelOrder(o: PendingOrder) {
    return this.request('DELETE', '/swap/v2/trade/order', { symbol: o.symbol, orderId: o.id });
  }

  async cancelAll(symbol?: string) {
    const symbols = symbol ? [symbol] : [...new Set((await this.getPendingOrders()).map((o) => o.symbol))];
    const res = await Promise.allSettled(symbols.map((s) => this.request('DELETE', '/swap/v2/trade/allOpenOrders', { symbol: s })));
    return res.flatMap((r, i) => (r.status === 'rejected' ? [`${this.baseOf(symbols[i])}: ${errorMessage(r.reason)}`] : []));
  }

  createPriceStream(onPrice: OnPrice, onStatus: OnStatus) {
    return pollingStream((s) => this.getFairPrice(s), onPrice, onStatus);
  }
}
