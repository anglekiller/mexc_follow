import { BASE_URLS, MexcApi, errorMessage, floorToUnit, positionPnl } from './lib/api.js';
import { FEEDS, fetchCalendar, fetchFeed } from './lib/news.js';
import { daysLeft, deleteVault, hasVault, KEY_WARN_DAYS, lockVault, saveVault, sessionCreds, unlockVault } from './lib/vault.js';
import { FairPriceSocket } from './lib/socket.js';
import { PriceChart } from './lib/chart.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 4_000;
const MARK_STALE_MS = 6_000;
const DEFAULT_SYMBOLS = ['XAU_USDT', 'SILVER_USDT', 'BTC_USDT', 'ETH_USDT', 'SOL_USDT'];
const INTERVALS = [
  ['Min1', 'M1'], ['Min5', 'M5'], ['Min15', 'M15'], ['Min30', 'M30'], ['Min60', 'H1'],
  ['Hour4', 'H4'], ['Day1', 'D1'], ['Week1', 'W1'], ['Month1', 'MN'],
];
const SIDE_LABEL = { 1: 'Mở Long', 2: 'Đóng Short', 3: 'Mở Short', 4: 'Đóng Long' };
const ORDER_TYPE_LABEL = { 1: 'Limit', 2: 'Post Only', 3: 'IOC', 4: 'FOK', 5: 'Market', 6: 'Market→Limit' };

const isPanel = new URLSearchParams(location.search).has('panel');
if (isPanel) document.body.classList.add('panel');

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function fmt(n, d = 2) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const [i, f] = Math.abs(n).toFixed(d).split('.');
  return `${n < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}
const signed = (n, d = 2) => `${n > 0 ? '+' : ''}${fmt(n, d)}`;
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const p2 = (n) => String(n).padStart(2, '0');
const hhmmss = (ms) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function settle(tasks) {
  const r = await Promise.allSettled(tasks.map((t) => t.run()));
  return r.flatMap((x, i) => (x.status === 'rejected' ? [`${tasks[i].label}: ${errorMessage(x.reason)}`] : []));
}

// ---------- state ----------

const S = {
  api: null,
  creds: null,
  asset: null,
  positions: [],
  orders: [],
  marks: {},
  markAt: {},
  contracts: {},
  tickers: [],
  watched: null,
  ws: 'closed',
  lastUpdate: 0,
  error: null,
  tab: 'portfolio',
  pfTab: 'pos',
};

const socket = new FairPriceSocket(
  (symbol, price) => {
    S.markAt[symbol] = Date.now();
    if (S.marks[symbol] === price) return;
    S.marks[symbol] = price;
    onPrices();
  },
  (status) => {
    S.ws = status;
    const pill = $('ws');
    pill.hidden = !S.api;
    pill.querySelector('b').textContent = status === 'open' ? 'Live' : status === 'connecting' ? 'Đang nối' : 'Polling';
    pill.querySelector('i').style.background = status === 'open' ? 'var(--long)' : status === 'connecting' ? 'var(--warn)' : 'var(--short)';
  },
);

const streamSymbols = () => [...new Set([...S.positions.map((p) => p.symbol), ...(S.watched ? [S.watched] : [])])];

async function ensureContract(symbol) {
  if (S.contracts[symbol]) return S.contracts[symbol];
  const c = await (S.api ?? new MexcApi()).getContract(symbol);
  S.contracts[symbol] = c;
  return c;
}

function views() {
  return S.positions.map((p) => {
    const mark = S.marks[p.symbol];
    const contract = S.contracts[p.symbol];
    return mark !== undefined && contract ? { ...p, mark, contract, ...positionPnl(p, mark, contract) } : { ...p, mark, contract };
  });
}

function unrealized(vs) {
  if (!vs.length) return 0;
  return vs.every((v) => v.pnl !== undefined) ? vs.reduce((s, v) => s + v.pnl, 0) : S.asset?.unrealized ?? 0;
}

let inFlight = false;
let timeSynced = false;

async function refresh() {
  if (!S.api || inFlight) return;
  inFlight = true;
  try {
    if (!timeSynced) {
      await S.api.syncTime();
      timeSynced = true;
    }
    const [assets, pos, open, plan, stop] = await Promise.all([
      S.api.getAssets(), S.api.getOpenPositions(), S.api.getOpenOrders(), S.api.getPlanOrders(), S.api.getStopOrders(),
    ]);
    S.asset = assets.find((a) => a.currency === 'USDT') ?? null;
    S.positions = pos;
    S.orders = [
      ...open.map((o) => ({ key: `l${o.orderId}`, kind: 'limit', id: o.orderId, symbol: o.symbol, side: o.side, typeLabel: ORDER_TYPE_LABEL[o.orderType] ?? `Type ${o.orderType}`, price: o.price, vol: o.vol, dealVol: o.dealVol, createTime: o.createTime })),
      ...plan.map((o) => ({ key: `p${o.id}`, kind: 'trigger', id: o.id, symbol: o.symbol, side: o.side, typeLabel: o.orderType === 5 ? 'Trigger Market' : 'Trigger Limit', price: o.orderType === 5 ? undefined : o.price, triggerPrice: o.triggerPrice, vol: o.vol, createTime: o.createTime })),
      ...stop.map((o) => ({ key: `s${o.id}`, kind: 'tpsl', id: o.id, symbol: o.symbol, typeLabel: 'TP/SL', takeProfitPrice: o.takeProfitPrice || undefined, stopLossPrice: o.stopLossPrice || undefined, vol: o.vol, createTime: o.createTime })),
    ].sort((a, b) => b.createTime - a.createTime);

    const symbols = [...new Set([...pos.map((p) => p.symbol), ...open.map((o) => o.symbol), ...(S.watched ? [S.watched] : [])])];
    await Promise.all(symbols.filter((s) => !S.contracts[s]).map((s) => ensureContract(s).catch(() => null)));

    // REST fallback: everything while the socket is down, otherwise symbols without a recent push.
    const now = Date.now();
    const priced = streamSymbols().filter((s) => S.ws !== 'open' || now - (S.markAt[s] ?? 0) > MARK_STALE_MS);
    const prices = await Promise.all(priced.map((s) => S.api.getFairPrice(s).catch(() => NaN)));
    priced.forEach((s, i) => {
      if (Number.isFinite(prices[i]) && (S.markAt[s] ?? 0) <= now) {
        S.marks[s] = prices[i];
        S.markAt[s] = Date.now();
      }
    });

    socket.setSymbols(streamSymbols());
    S.error = null;
    S.lastUpdate = Date.now();
  } catch (e) {
    if (/time|timestamp|recv/i.test(String(e?.message))) timeSynced = false;
    S.error = errorMessage(e);
  } finally {
    inFlight = false;
    renderPortfolio();
    renderTradeInfo();
  }
}

// Price ticks re-render at most once per animation frame.
let raf = 0;
function onPrices() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderPortfolio();
    renderTradeInfo();
    chart.setLive(S.marks[S.watched]);
  });
}

// ---------- boot / lock ----------

let pollTimer = null;

async function boot() {
  $('btnPanel').hidden = isPanel || !chrome.sidePanel;
  const creds = await sessionCreds();
  if (creds) return startSession(creds);
  if (await hasVault()) return showLock();
  // First run: settings only.
  showTabs(false);
  show('settings');
  renderSettings();
}

function showLock() {
  S.api = null;
  socket.stop();
  clearInterval(pollTimer);
  showTabs(false);
  $('btnLock').hidden = true;
  $('ws').hidden = true;
  show('lock');
  $('unlockPin').value = '';
  $('unlockPin').focus();
}

function startSession(creds) {
  S.creds = creds;
  S.api = new MexcApi(creds.apiKey, creds.secretKey, creds.baseUrl);
  timeSynced = false;
  showTabs(true);
  $('btnLock').hidden = false;
  socket.start();
  switchTab(S.tab === 'settings' && !creds ? 'settings' : S.tab);
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => !document.hidden && refresh(), POLL_MS);
  const left = daysLeft(creds);
  if (left <= KEY_WARN_DAYS) toast(left <= 0 ? 'API Key đã quá 90 ngày, hãy tạo key mới' : `API Key hết hạn sau ${left} ngày`, 4000);
}

$('unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('unlockErr').textContent = '';
  try {
    const creds = await unlockVault($('unlockPin').value);
    chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
    startSession(creds);
  } catch (err) {
    $('unlockErr').textContent = err.message;
  }
});

const lockNow = async () => {
  await lockVault();
  showLock();
};
$('btnLock').addEventListener('click', lockNow);
$('btnLockNow').addEventListener('click', lockNow);

$('btnPanel').addEventListener('click', async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
  window.close();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.api) {
    socket.reconnect();
    S.markAt = {};
    refresh();
  }
});

// ---------- tabs ----------

function showTabs(on) {
  $('tabs').hidden = !on;
}

function show(name) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
}

function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  show(tab);
  if (tab === 'portfolio') renderPortfolio();
  if (tab === 'trade') openTrade();
  if (tab === 'news') openNews();
  if (tab === 'settings') renderSettings();
  if (tab !== 'trade') setWatched(null);
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ---------- portfolio ----------

function renderPortfolio() {
  const vs = views();
  const total = unrealized(vs);
  $('posCount').textContent = S.positions.length ? S.positions.length : '';
  if (S.tab !== 'portfolio') return pushBadge(vs, total);

  $('equity').textContent = S.asset ? fmt(S.asset.equity) : '—';
  $('unreal').textContent = S.asset ? signed(total) : '—';
  $('unreal').className = `big ${cls(total)}`;
  $('avail').textContent = S.asset ? fmt(S.asset.availableBalance) : '—';
  $('margin').textContent = S.asset ? fmt(S.asset.positionMargin) : '—';
  $('updated').textContent = S.lastUpdate ? `⟳ ${hhmmss(S.lastUpdate)}` : '';
  $('nPos').textContent = S.positions.length ? `(${S.positions.length})` : '';
  $('nOrd').textContent = S.orders.length ? `(${S.orders.length})` : '';
  $('pfErr').textContent = S.error ?? '';

  const list = $('pfList');
  if (S.pfTab === 'pos') {
    list.innerHTML = vs.length ? vs.map(positionCard).join('') : `<div class="empty">Không có vị thế mở</div>`;
  } else {
    list.innerHTML = S.orders.length ? S.orders.map(orderRow).join('') : `<div class="empty">Không có lệnh chờ</div>`;
  }
  pushBadge(vs, total);
}

function positionCard(p) {
  const long = p.positionType === 1;
  const dp = p.contract?.priceScale ?? 4;
  const liqDist = p.mark && p.liquidatePrice > 0 ? (Math.abs(p.mark - p.liquidatePrice) / p.mark) * 100 : undefined;
  return `<div class="card pos">
    <div class="head">
      <span class="sym">${esc(p.symbol.replace('_USDT', ''))}</span>
      <span class="tag ${long ? 'long' : 'short'}">${long ? 'Long' : 'Short'} ${p.leverage}x</span>
      <span class="tag grey">${p.openType === 1 ? 'Isolated' : 'Cross'}</span>
      <div class="pnl ${cls(p.pnl ?? 0)}">${p.pnl !== undefined ? signed(p.pnl) : '…'}
        <div class="roe">${p.roe !== undefined ? signed(p.roe) + '%' : ''}</div></div>
    </div>
    <div class="grid">
      <div>Khối lượng<b>${fmt(p.holdVol, p.contract?.volScale ?? 0)} cont</b></div>
      <div>Giá vào<b>${fmt(p.holdAvgPrice, dp)}</b></div>
      <div>Giá đánh dấu<b>${fmt(p.mark, dp)}</b></div>
      <div class="${liqDist !== undefined && liqDist < 1 ? 'liqwarn' : ''}">Thanh lý<b>${fmt(p.liquidatePrice, dp)}</b></div>
      <div>Cách thanh lý<b>${liqDist !== undefined ? liqDist.toFixed(2) + '%' : '—'}</b></div>
      <div>Ký quỹ<b>${fmt(p.im)}</b></div>
    </div>
    <div class="actions">
      <button class="btn xs" data-close="${esc(p.positionId)}" data-frac="0.25">Đóng 25%</button>
      <button class="btn xs" data-close="${esc(p.positionId)}" data-frac="0.5">Đóng 50%</button>
      <button class="btn xs danger" data-close="${esc(p.positionId)}" data-frac="1">Đóng Market</button>
    </div>
  </div>`;
}

function orderRow(o) {
  const dp = S.contracts[o.symbol]?.priceScale ?? 4;
  const what = o.kind === 'tpsl'
    ? `TP ${o.takeProfitPrice ? fmt(o.takeProfitPrice, dp) : '—'} · SL ${o.stopLossPrice ? fmt(o.stopLossPrice, dp) : '—'}`
    : `${o.triggerPrice ? `Kích hoạt ${fmt(o.triggerPrice, dp)} · ` : ''}${o.price !== undefined ? `Giá ${fmt(o.price, dp)}` : 'Market'}`;
  const sideCls = o.side === 1 || o.side === 2 ? 'long' : o.side ? 'short' : 'grey';
  return `<div class="card order">
    <div class="meta">
      <div class="head row gap center-v"><span class="sym">${esc(o.symbol.replace('_USDT', ''))}</span>
        ${o.side ? `<span class="tag ${sideCls}">${SIDE_LABEL[o.side] ?? ''}</span>` : ''}
        <span class="tag grey">${esc(o.typeLabel)}</span></div>
      <div class="small muted">${what} · ${fmt(o.vol, 0)} cont${o.dealVol ? ` (khớp ${fmt(o.dealVol, 0)})` : ''}</div>
    </div>
    <button class="x" data-cancel="${esc(o.key)}" title="Hủy lệnh">✕</button>
  </div>`;
}

$('pfSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.pfTab = b.dataset.k;
  $('pfSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  renderPortfolio();
});

$('pfList').addEventListener('click', async (e) => {
  const closeBtn = e.target.closest('[data-close]');
  const cancelBtn = e.target.closest('[data-cancel]');
  if (closeBtn) {
    const p = views().find((v) => v.positionId === closeBtn.dataset.close);
    const frac = Number(closeBtn.dataset.frac);
    if (!p) return;
    const label = frac === 1 ? 'toàn bộ' : `${frac * 100}%`;
    if (!confirm(`Đóng ${label} vị thế ${p.symbol} ${p.positionType === 1 ? 'Long' : 'Short'} bằng lệnh Market?\nPnL hiện tại: ${p.pnl !== undefined ? signed(p.pnl) : '—'} USDT`)) return;
    closeBtn.disabled = true;
    try {
      const c = p.contract ?? (await ensureContract(p.symbol));
      let vol = p.holdVol;
      if (frac < 1) vol = Math.max(floorToUnit(p.holdVol * frac, c.volUnit, c.volScale), c.minVol);
      if (p.frozenVol > 0 && vol > p.holdVol - p.frozenVol) await S.api.cancelAllOrders(p.symbol);
      await S.api.closePositionMarket(p, p.mark ?? p.holdAvgPrice, Math.min(vol, p.holdVol));
      toast('Đã gửi lệnh đóng');
    } catch (err) {
      alert(`Đóng lệnh thất bại:\n${errorMessage(err)}`);
    }
    refresh();
  }
  if (cancelBtn) {
    const o = S.orders.find((x) => x.key === cancelBtn.dataset.cancel);
    if (!o) return;
    cancelBtn.disabled = true;
    try {
      if (o.kind === 'limit') await S.api.cancelOrders([o.id]);
      else if (o.kind === 'trigger') await S.api.cancelPlanOrders([o]);
      else await S.api.cancelStopOrders([o.id]);
      toast('Đã hủy lệnh');
    } catch (err) {
      alert(`Hủy lệnh thất bại:\n${errorMessage(err)}`);
    }
    refresh();
  }
});

const cancelAllTasks = () => [
  { label: 'Lệnh Limit', run: () => S.api.cancelAllOrders() },
  { label: 'Lệnh Trigger', run: () => S.api.cancelAllPlanOrders() },
  { label: 'Lệnh TP/SL', run: () => S.api.cancelAllStopOrders() },
];

$('btnCancelAll').addEventListener('click', async () => {
  if (!S.api || !confirm('Hủy TẤT CẢ lệnh chờ (Limit, Trigger, TP/SL)?')) return;
  const errs = await settle(cancelAllTasks());
  errs.length ? alert(errs.join('\n')) : toast('Đã hủy tất cả lệnh');
  refresh();
});

$('btnCloseAll').addEventListener('click', async () => {
  if (!S.api) return;
  if (!confirm('⚠ ĐÓNG TẤT CẢ vị thế bằng lệnh Market và hủy mọi lệnh chờ?\nThao tác không thể hoàn tác.')) return;
  const errs = await settle(cancelAllTasks());
  const fresh = await S.api.getOpenPositions().catch(() => []);
  errs.push(...(await settle(fresh.map((p) => ({
    label: `${p.symbol} ${p.positionType === 1 ? 'Long' : 'Short'}`,
    run: () => S.api.closePositionMarket(p, S.marks[p.symbol] ?? p.holdAvgPrice),
  })))));
  errs.length ? alert(`Một số thao tác lỗi:\n${errs.join('\n')}`) : toast('Đã đóng tất cả vị thế');
  refresh();
});

// While the UI is open its live numbers are fresher than the background poll.
let lastBadge = 0;
function pushBadge(vs, total) {
  if (!S.asset || Date.now() - lastBadge < 3_000 || vs.some((v) => v.pnl === undefined)) return;
  lastBadge = Date.now();
  const lines = vs.map((v) => `${v.symbol.replace('_USDT', '')} ${v.positionType === 1 ? 'Long' : 'Short'} ${v.leverage}x: ${signed(v.pnl)}`);
  chrome.runtime.sendMessage({
    type: 'badge',
    total: vs.length ? total : null,
    tooltip: [`MEXC Guard · ${hhmmss(Date.now())}`, `Equity: ${fmt(S.asset.equity)} USDT`, `PnL: ${signed(total)}`, ...lines].join('\n'),
  }).catch(() => {});
}

// ---------- trade ----------

const T = { symbol: null, interval: 'Min15', kline: null, klineTimer: null, ticker: null, unit: 'usdt', openType: 2, orderType: 5, recent: [] };
const chart = new PriceChart($('chart'), (o) => {
  $('ohlc').innerHTML = o ? `O <b>${o.o}</b> H <b>${o.h}</b> L <b>${o.l}</b> C <b>${o.c}</b>` : '';
});

function setWatched(sym) {
  S.watched = sym;
  socket.setSymbols(streamSymbols());
  if (!sym) clearInterval(T.klineTimer);
}

async function openTrade() {
  const st = await chrome.storage.local.get(['tradeSymbol', 'tradeInterval', 'recent']);
  T.recent = st.recent ?? [];
  if (!T.symbol) T.symbol = st.tradeSymbol ?? S.positions[0]?.symbol ?? 'XAU_USDT';
  T.interval = st.tradeInterval ?? T.interval;
  $('intervals').innerHTML = INTERVALS.map(([k, l]) => `<button class="chip ${k === T.interval ? 'on' : ''}" data-iv="${k}">${l}</button>`).join('');
  loadTickers();
  selectSymbol(T.symbol);
}

async function loadTickers() {
  if (T.tickersAt && Date.now() - T.tickersAt < 60_000) return;
  try {
    const all = await (S.api ?? new MexcApi()).getTickers();
    S.tickers = all.sort((a, b) => b.amount24 - a.amount24);
    T.tickersAt = Date.now();
    $('symList').innerHTML = S.tickers.slice(0, 400).map((t) => `<option value="${esc(t.symbol)}">`).join('');
  } catch {}
}

function renderQuick() {
  const syms = [...new Set([...S.positions.map((p) => p.symbol), ...T.recent, ...DEFAULT_SYMBOLS])].slice(0, 10);
  $('quick').innerHTML = syms.map((s) => `<button class="chip ${s === T.symbol ? 'on' : ''}" data-sym="${esc(s)}">${esc(s.replace('_USDT', ''))}</button>`).join('');
}

async function selectSymbol(sym) {
  sym = sym.trim().toUpperCase();
  if (!/_/.test(sym)) sym += '_USDT';
  try {
    const c = await ensureContract(sym);
    T.symbol = c.symbol;
  } catch (e) {
    toast(errorMessage(e));
    return;
  }
  $('symInput').value = T.symbol;
  T.recent = [T.symbol, ...T.recent.filter((s) => s !== T.symbol)].slice(0, 6);
  chrome.storage.local.set({ tradeSymbol: T.symbol, recent: T.recent });
  renderQuick();
  setWatched(T.symbol);
  const c = S.contracts[T.symbol];
  $('levRange').textContent = `(${c.minLeverage}–${c.maxLeverage}x)`;
  $('lev').max = c.maxLeverage;
  const held = S.positions.find((p) => p.symbol === T.symbol);
  if (held) $('lev').value = held.leverage;
  const presets = [5, 10, 20, 50, 100, 200, 500, 1000].filter((l) => l <= c.maxLeverage).slice(-4);
  $('levPresets').innerHTML = presets.map((l) => `<button class="chip" data-lev="${l}">${l}x</button>`).join('');
  $('pct').innerHTML = [10, 25, 50, 75, 100].map((p) => `<button class="chip" data-pct="${p}">${p}%</button>`).join('');
  if (!S.marks[T.symbol]) S.api?.getFairPrice(T.symbol).then((p) => { S.marks[T.symbol] ??= p; onPrices(); }).catch(() => {});
  loadKlines(true);
  clearInterval(T.klineTimer);
  T.klineTimer = setInterval(() => !document.hidden && loadKlines(false), 5_000);
}

async function loadKlines(reset) {
  const sym = T.symbol;
  const iv = T.interval;
  const api = S.api ?? new MexcApi();
  try {
    const [candles, ticker] = await Promise.all([api.getKlines(sym, iv), api.getTicker(sym)]);
    if (sym !== T.symbol || iv !== T.interval) return;
    T.ticker = ticker;
    const c = S.contracts[sym];
    const held = S.positions.filter((p) => p.symbol === sym);
    chart.setData(candles, {
      reset,
      priceScale: c?.priceScale ?? 2,
      intervalSec: { Min1: 60, Min5: 300, Min15: 900, Min30: 1800, Min60: 3600, Hour4: 14400, Day1: 86400, Week1: 604800, Month1: 2592000 }[iv],
      marks: held.flatMap((p) => [
        { price: p.holdAvgPrice, color: p.positionType === 1 ? '#00C087' : '#F6465D', label: `Vào ${p.positionType === 1 ? 'Long' : 'Short'}` },
        { price: p.liquidatePrice, color: '#F0B90B', label: 'Thanh lý' },
      ]),
      live: S.marks[sym],
    });
    renderTradeInfo();
  } catch {}
}

function renderTradeInfo() {
  if (S.tab !== 'trade' || !T.symbol) return;
  const c = S.contracts[T.symbol];
  const dp = c?.priceScale ?? 2;
  const t = T.ticker;
  const mark = S.marks[T.symbol] ?? t?.fairPrice;
  $('tPrice').textContent = fmt(mark, dp);
  if (t) {
    const v = t.riseFallValue;
    const ch = v !== undefined && t.lastPrice - v > 0 ? v / (t.lastPrice - v) : t.riseFallRate;
    $('tChange').innerHTML = `<span class="${cls(ch)}">${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(2)}%</span>`;
    $('tStats').innerHTML = `<span>Cao 24h <b class="txt">${fmt(t.high24Price, dp)}</b></span><span>Thấp <b class="txt">${fmt(t.lower24Price, dp)}</b></span><span>Funding <b class="txt">${t.fundingRate !== undefined ? (t.fundingRate * 100).toFixed(4) + '%' : '—'}</b></span>`;
  }
  // Order preview.
  const lev = num($('lev').value) || 1;
  const px = T.orderType === 1 ? num($('price').value) : mark ?? 0;
  const amt = num($('amount').value);
  let vol = 0;
  if (c && px > 0 && amt > 0) vol = floorToUnit(T.unit === 'cont' ? amt : (amt * lev) / (px * c.contractSize), c.volUnit, c.volScale);
  const notional = c ? vol * c.contractSize * px : 0;
  const avail = S.asset?.availableBalance ?? 0;
  $('orderInfo').innerHTML = c
    ? `Khả dụng <b class="txt">${fmt(avail)} USDT</b> · Khối lượng <b class="txt">${fmt(vol, c.volScale)} cont</b><br>
       Giá trị <b class="txt">${fmt(notional)} USDT</b> · Ký quỹ ≈ <b class="txt">${fmt(notional / lev)} USDT</b>${vol > 0 && vol < c.minVol ? ` · <span class="down">Tối thiểu ${c.minVol} cont</span>` : ''}`
    : '';
  T.vol = vol;
  $('priceRow').hidden = T.orderType !== 1;
}

function segPick(id, attr, cb) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    cb(b.dataset[attr]);
    renderTradeInfo();
  });
}
segPick('mType', 'v', (v) => (T.openType = Number(v)));
segPick('oType', 'v', (v) => {
  T.orderType = Number(v);
  if (T.orderType === 1 && !$('price').value && S.marks[T.symbol]) $('price').value = S.marks[T.symbol];
});
segPick('unit', 'u', (u) => (T.unit = u));
segPick('chartType', 't', (t) => chart.setType(t));

$('quick').addEventListener('click', (e) => { const b = e.target.closest('[data-sym]'); if (b) selectSymbol(b.dataset.sym); });
$('symInput').addEventListener('change', (e) => selectSymbol(e.target.value));
$('symInput').addEventListener('keydown', (e) => e.key === 'Enter' && selectSymbol(e.target.value));
$('intervals').addEventListener('click', (e) => {
  const b = e.target.closest('[data-iv]');
  if (!b) return;
  T.interval = b.dataset.iv;
  chrome.storage.local.set({ tradeInterval: T.interval });
  $('intervals').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  loadKlines(true);
});
$('levPresets').addEventListener('click', (e) => { const b = e.target.closest('[data-lev]'); if (b) { $('lev').value = b.dataset.lev; renderTradeInfo(); } });
$('pct').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pct]');
  if (!b) return;
  const avail = S.asset?.availableBalance ?? 0;
  const margin = (avail * Number(b.dataset.pct)) / 100;
  if (T.unit === 'usdt') $('amount').value = Math.floor(margin * 100) / 100;
  else {
    const c = S.contracts[T.symbol];
    const px = T.orderType === 1 ? num($('price').value) : S.marks[T.symbol];
    if (c && px) $('amount').value = floorToUnit((margin * num($('lev').value)) / (px * c.contractSize), c.volUnit, c.volScale);
  }
  renderTradeInfo();
});
['lev', 'price', 'amount'].forEach((id) => $(id).addEventListener('input', renderTradeInfo));

async function submit(long) {
  const c = S.contracts[T.symbol];
  if (!S.api || !c) return;
  renderTradeInfo();
  const lev = Math.round(num($('lev').value));
  const vol = T.vol;
  const price = T.orderType === 1 ? num($('price').value) : S.marks[T.symbol] ?? 0;
  const tp = num($('tp').value);
  const sl = num($('sl').value);
  const msg = $('tradeMsg');
  msg.className = 'small';
  if (lev < c.minLeverage || lev > c.maxLeverage) return (msg.textContent = `Đòn bẩy phải trong ${c.minLeverage}–${c.maxLeverage}x`), msg.classList.add('down');
  if (!vol || vol < c.minVol) return (msg.textContent = `Khối lượng tối thiểu ${c.minVol} cont`), msg.classList.add('down');
  if (T.orderType === 1 && !price) return (msg.textContent = 'Nhập giá Limit'), msg.classList.add('down');
  if (long ? (tp && tp <= price) || (sl && sl >= price) : (tp && tp >= price) || (sl && sl <= price))
    return (msg.textContent = long ? 'Long: TP phải cao hơn giá, SL thấp hơn giá' : 'Short: TP phải thấp hơn giá, SL cao hơn giá'), msg.classList.add('down');

  const text = `${long ? 'MỞ LONG' : 'MỞ SHORT'} ${T.symbol}\n${T.orderType === 5 ? 'Market' : `Limit @ ${price}`} · ${vol} cont · ${lev}x ${T.openType === 1 ? 'Isolated' : 'Cross'}` +
    `${tp ? `\nTP ${tp}` : ''}${sl ? `\nSL ${sl}` : ''}\n\nXác nhận đặt lệnh?`;
  if (!confirm(text)) return;
  const btn = $(long ? 'btnLong' : 'btnShort');
  btn.disabled = true;
  try {
    const order = { symbol: T.symbol, side: long ? 1 : 3, type: T.orderType, openType: T.openType, price, vol, leverage: lev };
    if (tp) order.takeProfitPrice = tp;
    if (sl) order.stopLossPrice = sl;
    const id = await S.api.placeOrder(order);
    msg.textContent = `Đã đặt lệnh #${id}`;
    msg.classList.add('up');
    refresh();
  } catch (e) {
    msg.textContent = `Lỗi: ${errorMessage(e)}`;
    msg.classList.add('down');
  } finally {
    btn.disabled = false;
  }
}
$('btnLong').addEventListener('click', () => submit(true));
$('btnShort').addEventListener('click', () => submit(false));

// ---------- news ----------

const NEWS = { tab: FEEDS[0].key, cache: new Map(), goldTimer: null, usdOnly: true, important: true };
const WEEKDAY = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const IMPACT = { High: '#F6465D', Medium: '#F7931A', Low: '#F0B90B', Holiday: '#8A8F98' };

function ago(ms) {
  if (!ms) return '';
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return 'vừa xong';
  if (min < 60) return `${min} phút trước`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = new Date(ms);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
}

function openNews() {
  $('newsSeg').innerHTML = [...FEEDS.map((f) => [f.key, f.label]), ['calendar', 'Lịch KT']]
    .map(([k, l]) => `<button data-k="${k}" class="${k === NEWS.tab ? 'on' : ''}">${esc(l)}</button>`).join('');
  loadNews();
  loadGold();
  clearInterval(NEWS.goldTimer);
  NEWS.goldTimer = setInterval(() => (S.tab === 'news' ? loadGold() : clearInterval(NEWS.goldTimer)), 5_000);
}

async function loadGold() {
  try {
    const t = await (S.api ?? new MexcApi()).getTicker('XAU_USDT');
    const v = t.riseFallValue;
    const ch = v !== undefined && t.lastPrice - v > 0 ? v / (t.lastPrice - v) : t.riseFallRate;
    $('goldPrice').textContent = fmt(S.marks.XAU_USDT ?? t.lastPrice, 2);
    $('goldChange').innerHTML = `<span class="${cls(ch)}">${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(2)}%</span>`;
  } catch {}
}

async function loadNews(force = false) {
  const body = $('newsBody');
  const tab = NEWS.tab;
  if (tab === 'calendar') return loadCalendar();
  const cached = NEWS.cache.get(tab);
  if (cached) body.innerHTML = cached.items.map(newsCard).join('');
  else body.innerHTML = '<div class="empty">Đang tải…</div>';
  if (!force && cached && Date.now() - cached.at < 120_000) return;
  try {
    const items = await fetchFeed(FEEDS.find((f) => f.key === tab));
    NEWS.cache.set(tab, { at: Date.now(), items });
    if (NEWS.tab === tab) body.innerHTML = items.map(newsCard).join('') || '<div class="empty">Chưa có tin</div>';
  } catch (e) {
    if (NEWS.tab === tab && !cached) body.innerHTML = `<p class="err">Không tải được tin: ${esc(e.message)}</p>`;
  }
}

function newsCard(n) {
  const fresh = n.time && Date.now() - n.time < 3_600_000;
  return `<a class="card news" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">
    <div class="grow">
      <div class="t">${esc(n.title)}</div>
      ${n.summary ? `<div class="s">${esc(n.summary)}</div>` : ''}
      <div class="m">${fresh ? '<span class="new">MỚI</span>' : ''}<span>${esc([n.source, ago(n.time)].filter(Boolean).join(' · '))}</span></div>
    </div>
    ${n.image ? `<img src="${esc(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
  </a>`;
}

async function loadCalendar() {
  const body = $('newsBody');
  body.innerHTML = '<div class="empty">Đang tải…</div>';
  let events;
  try {
    events = await fetchCalendar();
  } catch (e) {
    body.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (NEWS.tab !== 'calendar') return;
  const now = Date.now();
  const shown = events.filter((e) => (!NEWS.usdOnly || e.country === 'USD') && (!NEWS.important || e.impact === 'High' || e.impact === 'Medium'));
  const nextId = shown.find((e) => e.time > now)?.id;
  let day = '';
  let html = `<div class="chips"><button class="chip ${NEWS.usdOnly ? 'on' : ''}" data-f="usd">Chỉ USD</button><button class="chip ${NEWS.important ? 'on' : ''}" data-f="imp">Tác động cao/TB</button></div>
    <div class="small muted">Giờ theo máy tính · tin USD tác động mạnh thường làm vàng biến động lớn</div>`;
  for (const e of shown) {
    const d = new Date(e.time);
    const k = d.toDateString();
    if (k !== day) {
      day = k;
      html += `<div class="day">${WEEKDAY[d.getDay()]}, ${p2(d.getDate())}/${p2(d.getMonth() + 1)}</div>`;
    }
    const mins = Math.round((e.time - now) / 60_000);
    const cd = mins < 60 ? `${mins} phút nữa` : mins < 1440 ? `${Math.floor(mins / 60)}h${p2(mins % 60)} nữa` : `${Math.floor(mins / 1440)} ngày nữa`;
    html += `<div class="card event ${e.id === nextId ? 'next' : ''} ${e.time < now ? 'past' : ''}">
      <div class="time">${p2(d.getHours())}:${p2(d.getMinutes())}<div>${esc(e.country)}</div></div>
      <div class="bar" style="background:${IMPACT[e.impact] ?? IMPACT.Low}"></div>
      <div class="grow"><div class="title">${esc(e.titleVi ?? e.title)}</div>
        ${e.titleVi ? `<div class="sub">${esc(e.title)}</div>` : ''}
        ${e.forecast || e.previous ? `<div class="sub">${e.forecast ? `Dự báo ${esc(e.forecast)}` : ''}${e.forecast && e.previous ? ' · ' : ''}${e.previous ? `Trước ${esc(e.previous)}` : ''}</div>` : ''}
        ${e.id === nextId ? `<div class="cd">⏱ ${cd}</div>` : ''}</div>
    </div>`;
  }
  if (!shown.length) html += '<div class="empty">Không có sự kiện</div>';
  body.innerHTML = html;
}

$('newsSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  NEWS.tab = b.dataset.k;
  $('newsSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  loadNews();
});
$('newsBody').addEventListener('click', (e) => {
  const f = e.target.closest('[data-f]');
  if (!f) return;
  if (f.dataset.f === 'usd') NEWS.usdOnly = !NEWS.usdOnly;
  else NEWS.important = !NEWS.important;
  loadCalendar();
});

// ---------- settings ----------

async function renderSettings() {
  $('baseUrl').innerHTML = BASE_URLS.map((u) => `<option value="${u}">${u}</option>`).join('');
  const creds = S.creds;
  const vault = await hasVault();
  if (creds) {
    $('baseUrl').value = creds.baseUrl;
    const left = daysLeft(creds);
    $('keyStatus').innerHTML = `Đang dùng key <b>${esc(creds.apiKey.slice(0, 4))}••••${esc(creds.apiKey.slice(-4))}</b> · ` +
      `<span class="${left <= KEY_WARN_DAYS ? 'down' : 'up'}">${left > 0 ? `còn ${left} ngày` : 'đã quá 90 ngày, nên tạo key mới'}</span>`;
  } else {
    $('keyStatus').textContent = vault ? 'Đã lưu key (đang khóa).' : 'Chưa có API Key.';
  }
  const { settings = {} } = await chrome.storage.local.get('settings');
  $('liqPct').value = settings.liqAlertPct ?? 0.5;
  $('btnLockNow').disabled = !creds;
  $('btnDelete').disabled = !vault;
}

$('liqPct').addEventListener('change', async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings.liqAlertPct = Math.max(0, num($('liqPct').value));
  await chrome.storage.local.set({ settings });
  toast('Đã lưu');
});

function formCreds() {
  return { apiKey: $('apiKey').value.trim(), secretKey: $('secretKey').value.trim(), baseUrl: $('baseUrl').value };
}

$('btnTest').addEventListener('click', async () => {
  const f = formCreds();
  const msg = $('setMsg');
  if (!f.apiKey || !f.secretKey) return (msg.innerHTML = '<span class="down">Nhập API Key và Secret Key</span>');
  msg.textContent = 'Đang kiểm tra…';
  try {
    const api = new MexcApi(f.apiKey, f.secretKey, f.baseUrl);
    const latency = await api.syncTime();
    const assets = await api.getAssets();
    const usdt = assets.find((a) => a.currency === 'USDT');
    msg.innerHTML = `<span class="up">✓ Kết nối OK</span> · ${latency} ms · lệch giờ ${api.timeOffset} ms · Equity ${fmt(usdt?.equity ?? 0)} USDT`;
  } catch (e) {
    msg.innerHTML = `<span class="down">✗ ${esc(errorMessage(e))}</span>`;
  }
});

$('btnSave').addEventListener('click', async () => {
  const f = formCreds();
  const msg = $('setMsg');
  const pin = $('pin1').value;
  if (!f.apiKey || !f.secretKey) return (msg.innerHTML = '<span class="down">Nhập API Key và Secret Key</span>');
  if (pin.length < 4) return (msg.innerHTML = '<span class="down">PIN tối thiểu 4 ký tự</span>');
  if (pin !== $('pin2').value) return (msg.innerHTML = '<span class="down">Hai lần nhập PIN không khớp</span>');
  const creds = { ...f, createdAt: Date.now() };
  await saveVault(creds, pin);
  ['apiKey', 'secretKey', 'pin1', 'pin2'].forEach((id) => ($(id).value = ''));
  msg.innerHTML = '<span class="up">Đã lưu và mã hóa</span>';
  chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  S.tab = 'portfolio';
  startSession(creds);
});

$('btnDelete').addEventListener('click', async () => {
  if (!confirm('Xóa API Key đã lưu khỏi trình duyệt này?')) return;
  await deleteVault();
  S.creds = null;
  S.api = null;
  socket.stop();
  clearInterval(pollTimer);
  $('btnLock').hidden = true;
  $('ws').hidden = true;
  showTabs(false);
  show('settings');
  renderSettings();
  chrome.action.setBadgeText({ text: '' });
});

boot();
