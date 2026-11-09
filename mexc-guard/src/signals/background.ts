import * as SecureStore from 'expo-secure-store';

import { appendAlertLog } from '../alerts/log';
import { showNotification } from '../alerts/notify';
import type { Exchange } from '../exchanges';
import { aiComment } from './ai';
import { analyze } from './analyze';
import { INSTRUMENTS, type InstrumentId } from './instruments';

export interface SignalSettings {
  /** Notify when a new entry setup appears. */
  enabled: boolean;
  instruments: InstrumentId[];
}

const SETTINGS_KEY = 'signals_settings_v1';
const STATE_KEY = 'signals_state_v1';
const DEFAULTS: SignalSettings = { enabled: false, instruments: ['gold', 'silver', 'oil'] };
const CHECK_EVERY_MS = 5 * 60_000;
const SAME_SIGNAL_COOLDOWN_MS = 3 * 60 * 60_000;

export async function loadSignalSettings(): Promise<SignalSettings> {
  try {
    const json = await SecureStore.getItemAsync(SETTINGS_KEY);
    return json ? { ...DEFAULTS, ...(JSON.parse(json) as Partial<SignalSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSignalSettings(s: SignalSettings) {
  return SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(s));
}

interface State {
  lastRun: number;
  sent: Record<string, number>;
}

let running = false;

/**
 * Checks gold / silver / oil for new entry setups at most every 5 minutes and notifies each new
 * one (same setup at most every 3 hours). Called from the app and from the widget service.
 */
export async function checkSignals(api: Exchange | null) {
  if (!api || running) return;
  const settings = await loadSignalSettings();
  if (!settings.enabled) return;
  let state: State = { lastRun: 0, sent: {} };
  try {
    const json = await SecureStore.getItemAsync(STATE_KEY);
    if (json) state = JSON.parse(json) as State;
  } catch {}
  const now = Date.now();
  if (now - state.lastRun < CHECK_EVERY_MS) return;

  running = true;
  try {
    state.lastRun = now;
    for (const inst of INSTRUMENTS.filter((i) => settings.instruments.includes(i.id))) {
      const v = await analyze(api, inst).catch(() => null);
      const s = v?.setup;
      if (!v || !s?.plan) continue;
      const key = `${v.symbol}:${s.kind}:${s.side}`;
      if (state.sent[key] && now - state.sent[key] < SAME_SIGNAL_COOLDOWN_MS) continue;
      state.sent[key] = now;

      const d = (n: number) => Number(n.toPrecision(6));
      const plan = `Vào ~${d(s.plan.entry)} · SL ${d(s.plan.sl)} · TP ${d(s.plan.tp1)} / ${d(s.plan.tp2)}`;
      const ai = await aiComment(v).catch(() => undefined);
      const title = `${inst.icon} ${inst.name}: ${s.title}`;
      const detail = `${s.reason} ${plan}`;
      await showNotification(title, ai ? `${ai}\n\n${plan}` : detail).catch(() => {});
      await appendAlertLog([{ id: `sig:${key}:${now}`, time: now, level: 'info', symbol: v.symbol, title, detail, ai }]);
    }
    const cutoff = now - 24 * 60 * 60_000;
    state.sent = Object.fromEntries(Object.entries(state.sent).filter(([, t]) => t > cutoff));
    await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state)).catch(() => {});
  } finally {
    running = false;
  }
}
