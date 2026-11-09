// Public futures WebSocket: streams fair (mark) price, with a watchdog for silently dead sockets.

const WS_URL = 'wss://contract.mexc.com/edge';
const PING_MS = 10_000;
const STALE_MS = 25_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;

export class FairPriceSocket {
  constructor(onPrice, onStatus) {
    this.onPrice = onPrice;
    this.onStatus = onStatus;
    this.ws = null;
    this.symbols = new Set();
    this.pingTimer = null;
    this.retryTimer = null;
    this.connectTimer = null;
    this.backoff = 1_000;
    this.stopped = true;
    this.lastFrameAt = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoff = 1_000;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
    this.onStatus('closed');
  }

  reconnect() {
    if (this.stopped) return this.start();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
    this.backoff = 1_000;
    this.connect();
  }

  setSymbols(next) {
    const wanted = new Set(next);
    for (const s of this.symbols) if (!wanted.has(s)) this.send('unsub.fair.price', s);
    for (const s of wanted) if (!this.symbols.has(s)) this.send('sub.fair.price', s);
    this.symbols = wanted;
  }

  connect() {
    this.onStatus('connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.connectTimer = setTimeout(() => ws.readyState !== WebSocket.OPEN && this.dropAndRetry(), CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.backoff = 1_000;
      this.lastFrameAt = Date.now();
      this.onStatus('open');
      for (const s of this.symbols) this.send('sub.fair.price', s);
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastFrameAt > STALE_MS) return this.dropAndRetry();
        this.sendRaw({ method: 'ping' });
      }, PING_MS);
    };
    ws.onmessage = (e) => {
      this.lastFrameAt = Date.now();
      try {
        const msg = JSON.parse(e.data);
        if (msg.channel === 'push.fair.price' && msg.data) this.onPrice(msg.data.symbol ?? msg.symbol, Number(msg.data.price));
      } catch {}
    };
    ws.onclose = () => this.dropAndRetry();
    ws.onerror = () => this.dropAndRetry();
  }

  dropAndRetry() {
    this.teardown();
    if (this.stopped || this.retryTimer) return;
    this.onStatus('closed');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  teardown() {
    clearInterval(this.pingTimer);
    clearTimeout(this.connectTimer);
    this.pingTimer = this.connectTimer = null;
    if (this.ws) {
      const ws = this.ws;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch {}
      this.ws = null;
    }
  }

  send(method, symbol) {
    this.sendRaw({ method, param: { symbol } });
  }

  sendRaw(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
