// Live mark-price streams. WebSocket streams share reconnect, connect-timeout and a watchdog for
// sockets that die silently (Doze, network switch); BingX (gzip-only socket) is polled over REST.

import type { OnPrice, OnStatus, PriceStream } from './types';

const PING_MS = 10_000;
const STALE_MS = 25_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;

interface WsSpec {
  url: string;
  /** Messages to (un)subscribe these symbols. */
  subscribe(symbols: string[]): object[];
  unsubscribe(symbols: string[]): object[];
  /** Keep-alive frame, if the server wants one from the client. */
  ping?: object;
  parse(msg: any, emit: OnPrice): void;
}

class WsPriceStream implements PriceStream {
  private ws: WebSocket | null = null;
  private symbols = new Set<string>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1_000;
  private stopped = true;
  private lastFrameAt = 0;

  constructor(
    private readonly spec: WsSpec,
    private readonly onPrice: OnPrice,
    private readonly onStatus: OnStatus,
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.backoff = 1_000;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
    this.onStatus('closed');
  }

  reconnect() {
    if (this.stopped) return this.start();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown();
    this.backoff = 1_000;
    this.connect();
  }

  setSymbols(next: string[]) {
    const wanted = new Set(next);
    const removed = [...this.symbols].filter((s) => !wanted.has(s));
    const added = [...wanted].filter((s) => !this.symbols.has(s));
    if (removed.length) this.spec.unsubscribe(removed).forEach((m) => this.sendRaw(m));
    if (added.length) this.spec.subscribe(added).forEach((m) => this.sendRaw(m));
    this.symbols = wanted;
  }

  private connect() {
    this.onStatus('connecting');
    const ws = new WebSocket(this.spec.url);
    this.ws = ws;
    this.connectTimer = setTimeout(() => ws.readyState !== WebSocket.OPEN && this.dropAndRetry(), CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.backoff = 1_000;
      this.lastFrameAt = Date.now();
      this.onStatus('open');
      if (this.symbols.size) this.spec.subscribe([...this.symbols]).forEach((m) => this.sendRaw(m));
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastFrameAt > STALE_MS) return this.dropAndRetry();
        if (this.spec.ping) this.sendRaw(this.spec.ping);
      }, PING_MS);
    };

    ws.onmessage = (e) => {
      this.lastFrameAt = Date.now();
      try {
        this.spec.parse(JSON.parse(String(e.data)), this.onPrice);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => this.dropAndRetry();
    ws.onerror = () => this.dropAndRetry();
  }

  private dropAndRetry() {
    this.teardown();
    if (this.stopped || this.retryTimer) return;
    this.onStatus('closed');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private teardown() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.pingTimer = null;
    this.connectTimer = null;
    if (this.ws) {
      const ws = this.ws;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closing
      }
      this.ws = null;
    }
  }

  private sendRaw(payload: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}

export function mexcStream(onPrice: OnPrice, onStatus: OnStatus): PriceStream {
  return new WsPriceStream(
    {
      url: 'wss://contract.mexc.com/edge',
      // One message per symbol.
      subscribe: (syms) => syms.map((symbol) => ({ method: 'sub.fair.price', param: { symbol } })),
      unsubscribe: (syms) => syms.map((symbol) => ({ method: 'unsub.fair.price', param: { symbol } })),
      ping: { method: 'ping' },
      parse: (msg, emit) => {
        if (msg.channel === 'push.fair.price' && msg.data) emit(msg.data.symbol ?? msg.symbol, Number(msg.data.price));
      },
    },
    onPrice,
    onStatus,
  );
}

export function binanceStream(onPrice: OnPrice, onStatus: OnStatus): PriceStream {
  let id = 0;
  const params = (symbols: string[]) => symbols.map((s) => `${s.toLowerCase()}@markPrice@1s`);
  return new WsPriceStream(
    {
      // Market streams moved to the /market path (the bare /ws path accepts subscriptions but sends nothing).
      url: 'wss://fstream.binance.com/market/ws',
      subscribe: (s) => [{ method: 'SUBSCRIBE', params: params(s), id: ++id }],
      unsubscribe: (s) => [{ method: 'UNSUBSCRIBE', params: params(s), id: ++id }],
      parse: (msg, emit) => {
        const d = msg.data ?? msg;
        if (d.e === 'markPriceUpdate') emit(d.s, Number(d.p));
      },
    },
    onPrice,
    onStatus,
  );
}

/** Polls `fetchPrice` for every symbol; reports 'open' while polls succeed. */
export function pollingStream(
  fetchPrice: (symbol: string) => Promise<number>,
  onPrice: OnPrice,
  onStatus: OnStatus,
  everyMs = 2_000,
): PriceStream {
  let symbols: string[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const tick = async () => {
    if (busy || !symbols.length) return;
    busy = true;
    const res = await Promise.allSettled(symbols.map((s) => fetchPrice(s).then((p) => [s, p] as const)));
    busy = false;
    let ok = false;
    for (const r of res) {
      if (r.status === 'fulfilled' && Number.isFinite(r.value[1])) {
        ok = true;
        onPrice(r.value[0], r.value[1]);
      }
    }
    onStatus(ok ? 'open' : 'closed');
  };
  const stream: PriceStream = {
    start() {
      if (timer) return;
      onStatus('connecting');
      tick();
      timer = setInterval(tick, everyMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      onStatus('closed');
    },
    reconnect() {
      stream.stop();
      stream.start();
    },
    setSymbols(next) {
      const fresh = next.filter((s) => !symbols.includes(s));
      symbols = [...next];
      if (fresh.length && timer) tick();
    },
  };
  return stream;
}
