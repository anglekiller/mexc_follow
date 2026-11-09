// Binance USDⓈ-M Futures. Quantities are in coins (contractSize = 1). Since 2025-12-09 conditional
// orders (TP/SL, stops) live in the Algo Order API (/fapi/v1/algoOrder), not /fapi/v1/order.

import type { Asset, Candle, ContractInfo, KlineInterval, NewOrder, PendingOrder, Position, Ticker } from '../api/types';
import { changeRate, decimalsOf, ExchangeError, errorMessage, httpJson, num, queryString, STD_INTERVAL, type HmacFn } from './common';
import { binanceStream } from './streams';
import type { Exchange, OnPrice, OnStatus } from './types';

const BASE = 'https://fapi.binance.com';
const RECV_WINDOW = 10_000;
const DUAL_TTL_MS = 60_000;

type Params = Record<string, string | number | boolean | undefined>;

/** MEXC side numbering from Binance side + positionSide (+ reduceOnly in one-way mode). */
function sideNum(side: string, positionSide: string, reduceOnly?: boolean) {
  if (positionSide === 'LONG') return side === 'BUY' ? 1 : 4;
  if (positionSide === 'SHORT') return side === 'SELL' ? 3 : 2;
  if (side === 'BUY') return reduceOnly ? 2 : 1;
  return reduceOnly ? 4 : 3;
}

export class BinanceExchange implements Exchange {
  readonly id = 'binance' as const;
  readonly name = 'Binance';
  readonly unitLabel = 'Coin';
  readonly defaultSymbols = ['XAUUSDT', 'XAGUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  readonly goldSymbol = 'XAUUSDT';
  private timeOffset = 0;
  private info: Promise<Map<string, any>> | null = null;
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
    const { serverTime } = await this.request('GET', '/fapi/v1/time', {}, false);
    const t1 = Date.now();
    this.timeOffset = serverTime - Math.round((t0 + t1) / 2);
    return t1 - t0;
  }

  normalizeSymbol(input: string) {
    const s = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.endsWith('USDT') ? s : `${s}USDT`;
  }

  baseOf(symbol: string) {
    return symbol.replace(/USDT$/, '');
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}, signed = true): Promise<any> {
    let qs: string;
    const headers: Record<string, string> = {};
    if (signed) {
      if (!this.apiKey) throw new ExchangeError('Chưa có API Key');
      qs = queryString({ ...params, recvWindow: RECV_WINDOW, timestamp: this.now() }, true);
      qs += `&signature=${await this.hmac(this.secretKey, qs)}`;
      headers['X-MBX-APIKEY'] = this.apiKey;
    } else {
      qs = queryString(params, true);
    }
    const { status, json } = await httpJson(`${BASE}${path}${qs ? `?${qs}` : ''}`, { method, headers });
    if (json && typeof json === 'object' && !Array.isArray(json) && typeof json.code === 'number' && json.code < 0) {
      throw new ExchangeError(json.msg || `Lỗi ${json.code}`, json.code);
    }
    if (status >= 400) throw new ExchangeError(json?.msg || `HTTP ${status}`, json?.code ?? status);
    return json;
  }

  // ---------- Public ----------

  private exchangeInfo() {
    if (!this.info) {
      this.info = this.request('GET', '/fapi/v1/exchangeInfo', {}, false)
        .then((d) => {
          const map = new Map<string, any>();
          for (const s of d.symbols)
            if (s.quoteAsset === 'USDT' && s.status === 'TRADING' && /PERPETUAL/.test(s.contractType)) map.set(s.symbol, s);
          return map;
        })
        .catch((e) => {
          this.info = null;
          throw e;
        });
    }
    return this.info;
  }

  async getContract(symbol: string): Promise<ContractInfo> {
    const s = (await this.exchangeInfo()).get(symbol);
    if (!s) throw new ExchangeError(`Không tìm thấy hợp đồng ${symbol}`);
    const f = (t: string) => s.filters.find((x: any) => x.filterType === t) ?? {};
    const price = f('PRICE_FILTER');
    const lot = f('LOT_SIZE');
    const mlot = f('MARKET_LOT_SIZE');
    return {
      symbol,
      baseCoin: s.baseAsset,
      contractSize: 1,
      priceScale: decimalsOf(price.tickSize ?? '0.01'),
      priceUnit: num(price.tickSize),
      volScale: decimalsOf(lot.stepSize ?? '0.001'),
      volUnit: num(lot.stepSize),
      minVol: num(lot.minQty),
      maxVol: Math.min(num(lot.maxQty) || Infinity, num(mlot.maxQty) || Infinity),
      minLeverage: 1,
      maxLeverage: await this.maxLeverage(symbol),
      minNotional: num(f('MIN_NOTIONAL').notional),
    };
  }

  private async maxLeverage(symbol: string) {
    const cached = this.maxLev.get(symbol);
    if (cached) return cached;
    if (!this.apiKey) return 125;
    try {
      const d = await this.request('GET', '/fapi/v1/leverageBracket', { symbol });
      const lev = num((Array.isArray(d) ? d[0] : d)?.brackets?.[0]?.initialLeverage) || 125;
      this.maxLev.set(symbol, lev);
      return lev;
    } catch {
      return 125;
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const [t, p] = await Promise.all([
      this.request('GET', '/fapi/v1/ticker/24hr', { symbol }, false),
      this.request('GET', '/fapi/v1/premiumIndex', { symbol }, false),
    ]);
    return this.ticker(t, num(p.markPrice), num(p.lastFundingRate));
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

  async getTickers() {
    const [all, info] = await Promise.all([this.request('GET', '/fapi/v1/ticker/24hr', {}, false), this.exchangeInfo()]);
    return (all as any[]).filter((t) => info.has(t.symbol)).map((t) => this.ticker(t));
  }

  async getFairPrice(symbol: string) {
    return num((await this.request('GET', '/fapi/v1/premiumIndex', { symbol }, false)).markPrice);
  }

  async getKlines(symbol: string, interval: KlineInterval, count = 300): Promise<Candle[]> {
    const rows = await this.request('GET', '/fapi/v1/klines', { symbol, interval: STD_INTERVAL[interval], limit: Math.min(count, 1500) }, false);
    return (rows as any[]).map((r) => ({
      time: Math.floor(r[0] / 1000),
      open: num(r[1]),
      high: num(r[2]),
      low: num(r[3]),
      close: num(r[4]),
      vol: num(r[5]),
    }));
  }

  // ---------- Private ----------

  private async isDual() {
    if (this.dual && Date.now() - this.dual.at < DUAL_TTL_MS) return this.dual.value;
    const d = await this.request('GET', '/fapi/v1/positionSide/dual');
    this.dual = { at: Date.now(), value: d.dualSidePosition === true || d.dualSidePosition === 'true' };
    return this.dual.value;
  }

  async getAccount(): Promise<Asset | null> {
    const a = await this.request('GET', '/fapi/v3/account');
    return {
      currency: 'USDT',
      equity: num(a.totalMarginBalance),
      availableBalance: num(a.availableBalance),
      positionMargin: num(a.totalPositionInitialMargin ?? a.totalInitialMargin),
      cashBalance: num(a.totalWalletBalance),
      frozenBalance: num(a.totalOpenOrderInitialMargin),
      unrealized: num(a.totalUnrealizedProfit),
    };
  }

  async getOpenPositions(): Promise<Position[]> {
    let rows: any[];
    try {
      // v2 still carries leverage and marginType; v3 moved them to /fapi/v1/symbolConfig.
      rows = await this.request('GET', '/fapi/v2/positionRisk');
    } catch (e) {
      if (!(e instanceof ExchangeError) || (typeof e.code === 'number' && e.code < 0 && e.code !== -5000)) throw e;
      rows = await this.request('GET', '/fapi/v3/positionRisk');
      const open = rows.filter((r) => num(r.positionAmt) !== 0);
      const cfg = await Promise.all(
        [...new Set(open.map((r) => r.symbol))].map((symbol) =>
          this.request('GET', '/fapi/v1/symbolConfig', { symbol }).then((c) => (Array.isArray(c) ? c[0] : c)).catch(() => null),
        ),
      );
      for (const r of open) {
        const c = cfg.find((x) => x?.symbol === r.symbol);
        r.leverage = c?.leverage;
        r.marginType = c?.marginType ?? (num(r.isolatedWallet) > 0 ? 'isolated' : 'cross');
      }
    }
    return rows
      .filter((r) => num(r.positionAmt) !== 0)
      .map<Position>((r) => {
        const amt = num(r.positionAmt);
        const lev = num(r.leverage) || 1;
        const isolated = /isolated/i.test(String(r.marginType));
        return {
          positionId: `${r.symbol}:${r.positionSide}`,
          symbol: r.symbol,
          positionType: r.positionSide === 'SHORT' || (r.positionSide !== 'LONG' && amt < 0) ? 2 : 1,
          openType: isolated ? 1 : 2,
          state: 1,
          holdVol: Math.abs(amt),
          frozenVol: 0,
          holdAvgPrice: num(r.entryPrice),
          openAvgPrice: num(r.entryPrice),
          liquidatePrice: num(r.liquidationPrice),
          im: num(r.initialMargin) || (isolated ? num(r.isolatedMargin) : Math.abs(num(r.notional)) / lev),
          oim: 0,
          leverage: lev,
          realised: 0,
          createTime: 0,
          updateTime: num(r.updateTime),
          positionSide: r.positionSide,
        };
      });
  }

  async getPendingOrders(): Promise<PendingOrder[]> {
    const [open, algo] = await Promise.all([
      this.request('GET', '/fapi/v1/openOrders'),
      this.request('GET', '/fapi/v1/openAlgoOrders').catch(() => []),
    ]);
    const algoRows: any[] = Array.isArray(algo) ? algo : algo?.orders ?? algo?.rows ?? [];
    return [
      ...(open as any[]).map<PendingOrder>((o) => ({
        key: `l${o.orderId}`,
        kind: 'limit',
        id: String(o.orderId),
        symbol: o.symbol,
        side: sideNum(o.side, o.positionSide, o.reduceOnly),
        typeLabel: o.type === 'LIMIT' ? 'Limit' : o.type,
        price: num(o.price) || undefined,
        vol: num(o.origQty),
        dealVol: num(o.executedQty),
        createTime: num(o.time),
      })),
      ...algoRows.map<PendingOrder>((o) => {
        const type = String(o.orderType ?? o.type ?? '');
        const trigger = num(o.triggerPrice);
        const tpsl = o.closePosition === true || o.closePosition === 'true';
        const isTp = /TAKE_PROFIT/.test(type);
        return {
          key: `a${o.algoId}`,
          kind: tpsl ? 'tpsl' : 'trigger',
          id: String(o.algoId),
          symbol: o.symbol,
          side: sideNum(o.side, o.positionSide, o.reduceOnly === true || tpsl),
          typeLabel: tpsl ? (isTp ? 'Chốt lời (TP)' : 'Cắt lỗ (SL)') : type.replace(/_/g, ' '),
          price: num(o.price) || undefined,
          triggerPrice: tpsl ? undefined : trigger,
          takeProfitPrice: tpsl && isTp ? trigger : undefined,
          stopLossPrice: tpsl && !isTp ? trigger : undefined,
          vol: num(o.quantity) || undefined,
          createTime: num(o.createTime),
        };
      }),
    ].sort((a, b) => b.createTime - a.createTime);
  }

  async placeOrder(o: NewOrder) {
    const [c, dual] = await Promise.all([this.getContract(o.symbol), this.isDual()]);
    const long = o.side === 1;
    // Margin mode and leverage are account settings per symbol on Binance.
    try {
      await this.request('POST', '/fapi/v1/marginType', { symbol: o.symbol, marginType: o.openType === 1 ? 'ISOLATED' : 'CROSSED' });
    } catch (e) {
      if (!(e instanceof ExchangeError && e.code === -4046)) throw e; // -4046: already that mode
    }
    await this.request('POST', '/fapi/v1/leverage', { symbol: o.symbol, leverage: o.leverage });

    const positionSide = dual ? (long ? 'LONG' : 'SHORT') : undefined;
    const res = await this.request('POST', '/fapi/v1/order', {
      symbol: o.symbol,
      side: long ? 'BUY' : 'SELL',
      positionSide,
      type: o.type === 1 ? 'LIMIT' : 'MARKET',
      timeInForce: o.type === 1 ? 'GTC' : undefined,
      price: o.type === 1 ? o.price.toFixed(c.priceScale) : undefined,
      quantity: o.vol.toFixed(c.volScale),
      newOrderRespType: 'ACK',
    });
    const orderId = String(res.orderId);

    // TP/SL as close-position conditional orders on the mark price.
    const legs = [
      o.takeProfitPrice ? { type: 'TAKE_PROFIT_MARKET', price: o.takeProfitPrice, label: 'TP' } : null,
      o.stopLossPrice ? { type: 'STOP_MARKET', price: o.stopLossPrice, label: 'SL' } : null,
    ].filter((x): x is { type: string; price: number; label: string } => x !== null);
    const failed: string[] = [];
    for (const leg of legs) {
      try {
        await this.request('POST', '/fapi/v1/algoOrder', {
          algoType: 'CONDITIONAL',
          symbol: o.symbol,
          side: long ? 'SELL' : 'BUY',
          positionSide,
          type: leg.type,
          triggerPrice: leg.price.toFixed(c.priceScale),
          closePosition: 'true',
          workingType: 'MARK_PRICE',
        });
      } catch (e) {
        failed.push(`${leg.label}: ${errorMessage(e)}`);
      }
    }
    if (failed.length) throw new ExchangeError(`Đã mở lệnh #${orderId} nhưng đặt ${failed.join('; ')}`);
    return orderId;
  }

  /**
   * TP/SL are close-position conditional (algo) orders on the mark price. Binance allows only one
   * of each per position side, so a changed leg is cancelled before its replacement is placed.
   */
  async setPositionTpSl(p: Position, tp: number | null, sl: number | null, current: PendingOrder[]) {
    const c = await this.getContract(p.symbol);
    const long = p.positionType === 1;
    const positionSide = p.positionSide || 'BOTH';
    const legs = [
      { want: tp, type: 'TAKE_PROFIT_MARKET', old: current.find((o) => o.takeProfitPrice !== undefined), oldPrice: (o: PendingOrder) => o.takeProfitPrice },
      { want: sl, type: 'STOP_MARKET', old: current.find((o) => o.stopLossPrice !== undefined), oldPrice: (o: PendingOrder) => o.stopLossPrice },
    ];
    for (const leg of legs) {
      if (leg.old && leg.want !== null && leg.oldPrice(leg.old) === leg.want) continue;
      if (leg.old) await this.cancelOrder(leg.old);
      if (leg.want === null) continue;
      await this.request('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol: p.symbol,
        side: long ? 'SELL' : 'BUY',
        positionSide,
        type: leg.type,
        triggerPrice: leg.want.toFixed(c.priceScale),
        closePosition: 'true',
        workingType: 'MARK_PRICE',
      });
    }
  }

  async closePositionMarket(p: Position, _price: number, vol = p.holdVol) {
    const c = await this.getContract(p.symbol);
    const oneWay = !p.positionSide || p.positionSide === 'BOTH';
    return this.request('POST', '/fapi/v1/order', {
      symbol: p.symbol,
      side: p.positionType === 1 ? 'SELL' : 'BUY',
      positionSide: oneWay ? undefined : p.positionSide,
      reduceOnly: oneWay ? 'true' : undefined,
      type: 'MARKET',
      quantity: vol.toFixed(c.volScale),
      newOrderRespType: 'ACK',
    });
  }

  cancelOrder(o: PendingOrder) {
    if (o.key.startsWith('a')) return this.request('DELETE', '/fapi/v1/algoOrder', { algoId: o.id });
    return this.request('DELETE', '/fapi/v1/order', { symbol: o.symbol, orderId: o.id });
  }

  async cancelAll(symbol?: string) {
    // Binance cancels per symbol: sweep every symbol that has something pending.
    const symbols = symbol ? [symbol] : [...new Set((await this.getPendingOrders()).map((o) => o.symbol))];
    const tasks = symbols.flatMap((s) => [
      { label: `${this.baseOf(s)} lệnh thường`, run: () => this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol: s }) },
      { label: `${this.baseOf(s)} lệnh điều kiện`, run: () => this.request('DELETE', '/fapi/v1/algoOpenOrders', { symbol: s }) },
    ]);
    const res = await Promise.allSettled(tasks.map((t) => t.run()));
    return res.flatMap((r, i) => (r.status === 'rejected' ? [`${tasks[i].label}: ${errorMessage(r.reason)}`] : []));
  }

  createPriceStream(onPrice: OnPrice, onStatus: OnStatus) {
    return binanceStream(onPrice, onStatus);
  }
}
