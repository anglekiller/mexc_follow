// Service worker: keeps the toolbar badge showing total unrealized PnL (like the Android widget)
// and warns when a position gets close to its liquidation price.

import { MexcApi, positionPnl } from './lib/api.js';
import { sessionCreds } from './lib/vault.js';

const ALARM = 'pnl';
const LIQ_NOTIFY_EVERY_MS = 5 * 60_000;
const contracts = new Map();
const lastLiqNotice = new Map();
let api = null;
let apiKeyOf = '';

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

function setup() {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  update();
}

chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && update());

// The UI pushes fresh numbers while it is open, and asks for a refresh after lock/unlock.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'badge') paint(msg.total, msg.tooltip);
  if (msg?.type === 'refresh') update();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && 'creds' in changes) update();
});

function compact(n) {
  const a = Math.abs(n);
  const s = a >= 10_000 ? `${Math.round(a / 1000)}k` : a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(1);
  return (n > 0 ? '+' : n < 0 ? '-' : '') + s;
}

function paint(total, tooltip) {
  if (total === null) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: tooltip || 'MEXC Guard' });
    return;
  }
  chrome.action.setBadgeText({ text: compact(total) });
  chrome.action.setBadgeBackgroundColor({ color: total >= 0 ? '#00C087' : '#F6465D' });
  chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
  chrome.action.setTitle({ title: tooltip });
}

async function getApi() {
  const creds = await sessionCreds();
  if (!creds) return null;
  if (!api || apiKeyOf !== creds.apiKey + creds.baseUrl) {
    api = new MexcApi(creds.apiKey, creds.secretKey, creds.baseUrl);
    apiKeyOf = creds.apiKey + creds.baseUrl;
    await api.syncTime().catch(() => {});
  }
  return api;
}

async function update() {
  try {
    const a = await getApi();
    if (!a) return paint(null, 'MEXC Guard — đang khóa, mở để nhập PIN');
    const [assets, positions] = await Promise.all([a.getAssets(), a.getOpenPositions()]);
    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const [tickers] = await Promise.all([
      Promise.all(symbols.map((s) => a.getTicker(s))),
      Promise.all(symbols.filter((s) => !contracts.has(s)).map(async (s) => contracts.set(s, await a.getContract(s)))),
    ]);
    const usdt = assets.find((x) => x.currency === 'USDT');
    let total = 0;
    const lines = [];
    const { settings = {} } = await chrome.storage.local.get('settings');
    const liqPct = settings.liqAlertPct ?? 0.5;

    positions.forEach((p) => {
      const t = tickers[symbols.indexOf(p.symbol)];
      const { pnl } = positionPnl(p, t.fairPrice, contracts.get(p.symbol));
      total += pnl;
      const side = p.positionType === 1 ? 'Long' : 'Short';
      lines.push(`${p.symbol.replace('_USDT', '')} ${side} ${p.leverage}x: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);

      // Liquidation proximity alert.
      if (liqPct > 0 && p.liquidatePrice > 0) {
        const dist = (Math.abs(t.fairPrice - p.liquidatePrice) / t.fairPrice) * 100;
        const key = p.positionId;
        if (dist <= liqPct && Date.now() - (lastLiqNotice.get(key) ?? 0) > LIQ_NOTIFY_EVERY_MS) {
          lastLiqNotice.set(key, Date.now());
          chrome.notifications.create(`liq-${key}`, {
            type: 'basic',
            iconUrl: 'icons/128.png',
            title: `⚠ ${p.symbol} ${side} sắp thanh lý`,
            message: `Giá ${t.fairPrice} chỉ còn cách giá thanh lý ${p.liquidatePrice} khoảng ${dist.toFixed(2)}%`,
            priority: 2,
            requireInteraction: true,
          });
        }
      }
    });

    const time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    paint(
      positions.length ? total : 0,
      [`MEXC Guard · ${time}`, `Equity: ${usdt ? usdt.equity.toFixed(2) : '—'} USDT`, `PnL: ${total >= 0 ? '+' : ''}${total.toFixed(2)}`, ...lines].join('\n'),
    );
    if (!positions.length) chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F0B90B' });
    chrome.action.setTitle({ title: `MEXC Guard — lỗi: ${e?.message ?? e}` });
  }
}

chrome.notifications.onClicked.addListener(() => chrome.action.openPopup?.().catch(() => {}));
