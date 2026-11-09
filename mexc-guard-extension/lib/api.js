// MEXC Futures Open API v1 client (port of the Android app's mexcApi.ts), using WebCrypto for HMAC.

export const BASE_URLS = ['https://api.mexc.com', 'https://contract.mexc.com'];

const TIMEOUT_MS = 10_000;
const RECV_WINDOW_SEC = '30';

// MEXC ids exceed Number.MAX_SAFE_INTEGER: quote them before JSON.parse.
const BIG_ID_FIELDS = /("(?:orderId|id|positionId|stopPlanOrderId|planOrderId)"\s*:\s*)(\d{16,})/g;

// Mark a digit string so toJson() emits it as a bare JSON number (no precision loss).
const raw = (digits) => `@@${digits}@@`;
const toJson = (value) => JSON.stringify(value).replace(/"@@(\d+)@@"/g, '$1');

export const INTERVAL_SECONDS = {
  Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600,
  Hour4: 14400, Day1: 86400, Week1: 604800, Month1: 2592000,
};

export class MexcApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const errorMessage = (e) =>
  e instanceof MexcApiError && e.code !== undefined ? `${e.message} (code ${e.code})` : e?.message ?? String(e);

function listOf(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.resultList) ? data.resultList : [];
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export class MexcApi {
  constructor(apiKey, secretKey, baseUrl = BASE_URLS[0]) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeOffset = 0;
    this.hmacKey = secretKey
      ? crypto.subtle.importKey('raw', enc.encode(secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      : null;
  }

  now() {
    return Date.now() + this.timeOffset;
  }

  /** Measures drift against server time. Returns round-trip latency in ms. */
  async syncTime() {
    const t0 = Date.now();
    const serverTime = await this.request('GET', '/api/v1/contract/ping', { auth: false });
    const t1 = Date.now();
    this.timeOffset = serverTime - Math.round((t0 + t1) / 2);
    return t1 - t0;
  }

  /** HMAC-SHA256(secret, apiKey + reqTime + paramString), hex encoded. */
  async sign(reqTime, paramString) {
    return hex(await crypto.subtle.sign('HMAC', await this.hmacKey, enc.encode(this.apiKey + reqTime + paramString)));
  }

  async request(method, path, { query, body, auth = true } = {}) {
    // GET: params sorted by key, "k=v&k=v", empty values dropped. POST: the raw JSON body.
    const queryString = Object.keys(query ?? {})
      .filter((k) => query[k] !== undefined && query[k] !== '')
      .sort()
      .map((k) => `${k}=${query[k]}`)
      .join('&');

    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      if (!this.hmacKey) throw new MexcApiError('Chưa có API Key');
      const reqTime = String(this.now());
      headers.ApiKey = this.apiKey;
      headers['Request-Time'] = reqTime;
      headers['Recv-Window'] = RECV_WINDOW_SEC;
      headers.Signature = await this.sign(reqTime, method === 'GET' ? queryString : body ?? '');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let text, status;
    try {
      const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;
      const res = await fetch(url, { method, headers, body, signal: controller.signal, credentials: 'omit' });
      status = res.status;
      text = await res.text();
    } catch (e) {
      throw new MexcApiError(controller.signal.aborted ? 'Hết thời gian chờ phản hồi (timeout)' : `Lỗi mạng: ${e}`);
    } finally {
      clearTimeout(timer);
    }

    let json;
    try {
      json = JSON.parse(text.replace(BIG_ID_FIELDS, '$1"$2"'));
    } catch {
      throw new MexcApiError(`HTTP ${status}: phản hồi không hợp lệ`, status);
    }
    if (!json.success) throw new MexcApiError(json.message || `Lỗi ${json.code}`, json.code);
    return json.data;
  }

  // ---------- Public ----------

  async getContract(symbol) {
    const d = await this.request('GET', '/api/v1/contract/detail', { query: { symbol }, auth: false });
    if (!d || !d.symbol) throw new MexcApiError(`Không tìm thấy hợp đồng ${symbol}`);
    return d;
  }

  getTicker(symbol) {
    return this.request('GET', '/api/v1/contract/ticker', { query: { symbol }, auth: false });
  }

  async getFairPrice(symbol) {
    return (await this.getTicker(symbol)).fairPrice;
  }

  getTickers() {
    return this.request('GET', '/api/v1/contract/ticker', { auth: false });
  }

  async getKlines(symbol, interval, count = 300) {
    const end = Math.floor(this.now() / 1000);
    const d = await this.request('GET', `/api/v1/contract/kline/${symbol}`, {
      query: { interval, start: end - INTERVAL_SECONDS[interval] * count, end },
      auth: false,
    });
    return d.time.map((t, i) => ({ time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i], vol: d.vol[i] }));
  }

  // ---------- Account ----------

  getAssets() {
    return this.request('GET', '/api/v1/private/account/assets');
  }

  async getOpenPositions() {
    return listOf(await this.request('GET', '/api/v1/private/position/open_positions'));
  }

  async getOpenOrders() {
    return listOf(await this.request('GET', '/api/v1/private/order/list/open_orders', { query: { page_num: 1, page_size: 100 } }));
  }

  async getPlanOrders() {
    return listOf(await this.request('GET', '/api/v1/private/planorder/list/orders', { query: { states: 1, page_num: 1, page_size: 100 } }));
  }

  async getStopOrders() {
    return listOf(await this.request('GET', '/api/v1/private/stoporder/list/orders', { query: { is_finished: 0, page_num: 1, page_size: 100 } }));
  }

  // ---------- Trading ----------

  placeOrder(o) {
    return this.request('POST', '/api/v1/private/order/submit', { body: toJson(o) });
  }

  /** Market order on the closing side (close long = side 4, close short = side 2). */
  closePositionMarket(p, price, vol = p.holdVol) {
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

  cancelOrders(ids) {
    return this.request('POST', '/api/v1/private/order/cancel', { body: toJson(ids.map(raw)) });
  }

  cancelPlanOrders(orders) {
    return this.request('POST', '/api/v1/private/planorder/cancel', {
      body: toJson(orders.map((o) => ({ symbol: o.symbol, orderId: raw(o.id) }))),
    });
  }

  cancelStopOrders(ids) {
    return this.request('POST', '/api/v1/private/stoporder/cancel', { body: toJson(ids.map((id) => ({ stopPlanOrderId: raw(id) }))) });
  }

  cancelAllOrders(symbol) {
    return this.request('POST', '/api/v1/private/order/cancel_all', { body: toJson(symbol ? { symbol } : {}) });
  }

  cancelAllPlanOrders() {
    return this.request('POST', '/api/v1/private/planorder/cancel_all', { body: '{}' });
  }

  cancelAllStopOrders() {
    return this.request('POST', '/api/v1/private/stoporder/cancel_all', { body: '{}' });
  }
}

/** Unrealized PnL (USDT) and ROE (%) of a USDT-M position at `mark`. */
export function positionPnl(p, mark, contract) {
  const dir = p.positionType === 1 ? 1 : -1;
  const pnl = (mark - p.holdAvgPrice) * p.holdVol * contract.contractSize * dir;
  return { pnl, roe: p.im > 0 ? (pnl / p.im) * 100 : undefined };
}

export const floorToUnit = (v, unit, scale) => Number((Math.floor(v / unit + 1e-9) * unit).toFixed(scale));
