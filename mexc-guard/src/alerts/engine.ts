import * as SecureStore from 'expo-secure-store';

import type { Exchange } from '../exchanges';
import { fmt } from '../theme';
import { generate } from './gemini';
import { appendAlertLog, type AlertEntry, type AlertLevel } from './log';
import { showNotification } from './notify';
import { loadAlertSettings, loadGeminiKey, type AlertSettings } from './settings';

/** What the rules need to know about an open position. */
export interface WatchedPosition {
  id: string;
  symbol: string;
  name: string;
  long: boolean;
  leverage: number;
  entry: number;
  mark: number;
  liq: number;
  pnl: number;
  roe: number;
  /** Margin backing the position (USDT). */
  margin: number;
  tp?: number;
  sl?: number;
  openTime: number;
  priceDp: number;
}

interface AlertEvent {
  /** Cooldown key: rule + position (+ level). */
  key: string;
  cooldownMs: number;
  level: AlertLevel;
  p: WatchedPosition;
  title: string;
  detail: string;
}

const MIN = 60_000;
const MOVE_WINDOW = 5 * MIN;
const AI_PER_DAY = 40;
const MAX_EVENTS_PER_RUN = 3;

// ---------- Persisted state: cooldowns and the daily AI budget ----------

interface State {
  cooldowns: Record<string, number>;
  ai: { day: string; count: number };
}
const STATE_KEY = 'alerts_state_v1';
const today = () => new Date().toISOString().slice(0, 10);

async function loadState(): Promise<State> {
  try {
    const json = await SecureStore.getItemAsync(STATE_KEY);
    if (json) return JSON.parse(json) as State;
  } catch {}
  return { cooldowns: {}, ai: { day: today(), count: 0 } };
}

function saveState(s: State) {
  const cutoff = Date.now() - 24 * 60 * MIN;
  s.cooldowns = Object.fromEntries(Object.entries(s.cooldowns).filter(([, t]) => t > cutoff));
  return SecureStore.setItemAsync(STATE_KEY, JSON.stringify(s)).catch(() => {});
}

// ---------- Price samples (in memory; the headless runtime keeps them while the process lives) ----------

const samples = new Map<string, { t: number; p: number }[]>();

function record(symbol: string, price: number, now: number) {
  const list = samples.get(symbol) ?? [];
  if (!list.length || now - list[list.length - 1].t >= 5_000) list.push({ t: now, p: price });
  while (list.length && now - list[0].t > 60 * MIN) list.shift();
  samples.set(symbol, list);
}

/** Percent change from the oldest sample inside `window` (needs ≥ 2 minutes of data). */
function changeOver(symbol: string, window: number, now: number) {
  const list = samples.get(symbol) ?? [];
  const first = list.find((s) => now - s.t <= window);
  const last = list[list.length - 1];
  if (!first || !last || last.t - first.t < 2 * MIN) return null;
  return ((last.p - first.p) / first.p) * 100;
}

// ---------- Rules ----------

const pct = (n: number, d = 2) => `${n > 0 ? '+' : ''}${fmt(n, d)}%`;

function evaluate(positions: WatchedPosition[], s: AlertSettings, now: number): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const p of positions) {
    const side = `${p.name} ${p.long ? 'Long' : 'Short'} ${p.leverage}x`;
    const px = (n: number) => fmt(n, p.priceDp);

    // 1. Closing in on liquidation: share of the entry→liquidation distance still left.
    if (p.liq > 0 && p.entry !== p.liq) {
      const left = Math.abs(p.mark - p.liq) / Math.abs(p.entry - p.liq);
      const toLiq = (Math.abs(p.mark - p.liq) / p.mark) * 100;
      if (left < 0.5) {
        const critical = left < 0.25;
        events.push({
          key: `liq:${p.id}:${critical ? 2 : 1}`,
          cooldownMs: (critical ? 3 : 10) * MIN,
          level: critical ? 'critical' : 'warn',
          p,
          title: `${critical ? '🚨' : '⚠️'} ${side} sắp thanh lý`,
          detail: `Giá ${px(p.mark)}, thanh lý ${px(p.liq)} (còn ${fmt(toLiq, 2)}%, ${fmt(left * 100, 0)}% khoảng đệm). PnL ${pct(p.roe, 1)} ROE.`,
        });
      }
    }

    // 2. Sharp move within 5 minutes.
    const move = changeOver(p.symbol, MOVE_WINDOW, now);
    if (move !== null && Math.abs(move) >= s.movePct) {
      const against = (move < 0) === p.long;
      events.push({
        key: `move:${p.symbol}:${move > 0 ? 'up' : 'down'}`,
        cooldownMs: 10 * MIN,
        level: against ? 'warn' : 'info',
        p,
        title: `${move > 0 ? '📈' : '📉'} ${p.name} ${pct(move)} trong 5 phút`,
        detail: `${against ? 'Đi ngược' : 'Thuận'} vị thế ${side}. Giá ${px(p.mark)}, PnL ${fmt(p.pnl, 2)} USDT (${pct(p.roe, 1)} ROE).`,
      });
    }

    // 3. Deep loss.
    if (p.roe <= -s.lossRoe) {
      const critical = p.roe <= -Math.max(80, s.lossRoe + 20);
      events.push({
        key: `loss:${p.id}:${critical ? 2 : 1}`,
        cooldownMs: 30 * MIN,
        level: critical ? 'critical' : 'warn',
        p,
        title: `🔻 ${side} lỗ ${pct(p.roe, 0)} ROE`,
        detail: `Lỗ ${fmt(p.pnl, 2)} USDT trên margin ${fmt(p.margin, 2)}. Giá vào ${px(p.entry)}, hiện ${px(p.mark)}${p.sl ? `, SL ${px(p.sl)}` : ', chưa có SL'}.`,
      });
    }

    // 4. No stop-loss after 2 minutes.
    if (p.sl === undefined && now - p.openTime > 2 * MIN) {
      events.push({
        key: `nosl:${p.id}`,
        cooldownMs: 120 * MIN,
        level: 'info',
        p,
        title: `🛡️ ${side} chưa đặt cắt lỗ`,
        detail: `Giá vào ${px(p.entry)}, thanh lý ${px(p.liq)}. Nên đặt SL trước giá thanh lý.`,
      });
    }

    // 5. Good profit but the stop does not lock it in.
    const slLocks = p.sl !== undefined && (p.long ? p.sl >= p.entry : p.sl <= p.entry);
    if (p.roe >= 50 && !slLocks) {
      events.push({
        key: `protect:${p.id}`,
        cooldownMs: 60 * MIN,
        level: 'info',
        p,
        title: `💰 ${side} lãi ${pct(p.roe, 0)} ROE — chưa bảo vệ`,
        detail: `Lãi ${fmt(p.pnl, 2)} USDT. Có thể dời SL về hòa vốn (${px(p.entry)}) hoặc chốt một phần.`,
      });
    }
  }
  const order: Record<AlertLevel, number> = { critical: 0, warn: 1, info: 2 };
  return events.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------- Gemini ----------

const SYSTEM = [
  'Bạn là trợ lý quản lý rủi ro cho trader futures crypto (hợp đồng vĩnh cửu USDT).',
  'Trả lời bằng tiếng Việt, tối đa 3 câu ngắn, tổng dưới 300 ký tự, không dùng markdown hay gạch đầu dòng.',
  'Câu 1: nhận định ngắn tình huống dựa trên số liệu. Sau đó 1–2 hành động cụ thể (dời SL, giảm vị thế, chốt một phần, giữ nguyên…) kèm mức giá khi hợp lý.',
  'Ưu tiên bảo toàn vốn. Không khẳng định chắc chắn hướng giá. Không bịa số liệu ngoài dữ liệu được cung cấp.',
].join(' ');

async function marketContext(api: Exchange | null, symbol: string) {
  if (!api) return '';
  try {
    const candles = await api.getKlines(symbol, 'Min5', 25);
    if (candles.length < 4) return '';
    const last = candles[candles.length - 1].close;
    const ago = (n: number) => candles[Math.max(candles.length - 1 - n, 0)].close;
    const ch = (from: number) => pct(((last - from) / from) * 100);
    const hi = Math.max(...candles.map((c) => c.high));
    const lo = Math.min(...candles.map((c) => c.low));
    const avgRange = candles.reduce((s, c) => s + (c.high - c.low) / c.close, 0) / candles.length;
    return `Nến 5 phút (~2 giờ gần nhất): đổi 15p ${ch(ago(3))}, 1h ${ch(ago(12))}, 2h ${ch(candles[0].open)}; cao ${hi}, thấp ${lo}; biên độ TB mỗi nến ${fmt(avgRange * 100, 2)}%.`;
  } catch {
    return '';
  }
}

async function askGemini(key: string, settings: AlertSettings, api: Exchange | null, e: AlertEvent) {
  const p = e.p;
  const prompt = [
    `Sự kiện: ${e.title}. ${e.detail}`,
    `Vị thế: ${p.long ? 'Long' : 'Short'} ${p.symbol}, đòn bẩy ${p.leverage}x, giá vào ${p.entry}, giá hiện tại ${p.mark}, giá thanh lý ${p.liq || 'không rõ'}, margin ${fmt(p.margin, 2)} USDT, PnL ${fmt(p.pnl, 2)} USDT (${fmt(p.roe, 1)}% ROE).`,
    `TP: ${p.tp ?? 'chưa đặt'}. SL: ${p.sl ?? 'chưa đặt'}. Đã giữ ${Math.round((Date.now() - p.openTime) / MIN)} phút.`,
    await marketContext(api, p.symbol),
    'Đưa ra nhận định và gợi ý hành động.',
  ]
    .filter(Boolean)
    .join('\n');
  return generate(key, settings.model, SYSTEM, prompt, settings.models);
}

// ---------- Run ----------

let running = false;

/**
 * Records prices, evaluates the rules, and delivers new alerts (Gemini text + notification + log).
 * Safe to call often: cooldowns stop repeats, and overlapping calls are skipped. Returns how many
 * alerts were delivered.
 */
export async function runAlerts(api: Exchange | null, positions: WatchedPosition[], force?: AlertSettings): Promise<number> {
  const now = Date.now();
  for (const p of positions) if (p.mark > 0) record(p.symbol, p.mark, now);
  if (running) return 0;
  const settings = force ?? (await loadAlertSettings());
  if (!settings.enabled) return 0;
  running = true;
  try {
    const state = await loadState();
    if (state.ai.day !== today()) state.ai = { day: today(), count: 0 };
    const fresh = evaluate(positions, settings, now)
      .filter((e) => !(state.cooldowns[e.key] && now - state.cooldowns[e.key] < e.cooldownMs))
      .slice(0, MAX_EVENTS_PER_RUN);
    if (!fresh.length) return 0;

    const key = settings.aiEnabled && settings.model ? await loadGeminiKey() : '';
    const entries: AlertEntry[] = [];
    for (const e of fresh) {
      state.cooldowns[e.key] = now;
      let ai: string | undefined;
      if (key && state.ai.count < AI_PER_DAY) {
        state.ai.count++;
        ai = await askGemini(key, settings, api, e)
          .then((r) => r.text)
          .catch(() => undefined);
      }
      entries.push({ id: `${e.key}:${now}`, time: now, level: e.level, symbol: e.p.symbol, title: e.title, detail: e.detail, ai });
      await showNotification(e.title, ai ? `${ai}\n\n${e.detail}` : e.detail).catch(() => {});
    }
    await saveState(state);
    await appendAlertLog(entries);
    return entries.length;
  } finally {
    running = false;
  }
}

/** Sends one sample alert (Settings → "Gửi thử") to check notifications and the Gemini key. */
export async function sendTestAlert(api: Exchange | null, p: WatchedPosition | null, settings: AlertSettings) {
  const sample: WatchedPosition = p ?? {
    id: 'test',
    symbol: 'BTC_USDT',
    name: 'BTC',
    long: true,
    leverage: 20,
    entry: 100_000,
    mark: 98_500,
    liq: 95_500,
    pnl: -15,
    roe: -30,
    margin: 50,
    openTime: Date.now() - 30 * MIN,
    priceDp: 1,
  };
  const e: AlertEvent = {
    key: 'test',
    cooldownMs: 0,
    level: 'warn',
    p: sample,
    title: `🧪 Thử nhắc nhở · ${sample.name} ${sample.long ? 'Long' : 'Short'} ${sample.leverage}x`,
    detail: `Giá ${sample.mark}, PnL ${fmt(sample.pnl, 2)} USDT (${fmt(sample.roe, 1)}% ROE).`,
  };
  const key = settings.aiEnabled && settings.model ? await loadGeminiKey() : '';
  const res = key ? await askGemini(key, settings, api, e) : undefined;
  const ai = res?.text;
  await showNotification(e.title, ai ? `${ai}\n\n${e.detail}` : e.detail);
  await appendAlertLog([{ id: `test:${Date.now()}`, time: Date.now(), level: 'info', symbol: sample.symbol, title: e.title, detail: e.detail, ai }]);
  return res;
}
