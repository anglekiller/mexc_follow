import * as SecureStore from 'expo-secure-store';

export type AlertLevel = 'info' | 'warn' | 'critical';

/** One delivered reminder, as shown in the app. */
export interface AlertEntry {
  id: string;
  time: number;
  level: AlertLevel;
  symbol: string;
  title: string;
  /** Rule-based description of what happened. */
  detail: string;
  /** Gemini's analysis / suggestion, when it answered. */
  ai?: string;
}

const LOG_KEY = 'alerts_log_v1';
const MAX = 30;

export async function loadAlertLog(): Promise<AlertEntry[]> {
  try {
    const json = await SecureStore.getItemAsync(LOG_KEY);
    return json ? (JSON.parse(json) as AlertEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendAlertLog(entries: AlertEntry[]) {
  if (!entries.length) return;
  const next = [...entries, ...(await loadAlertLog())].slice(0, MAX);
  await SecureStore.setItemAsync(LOG_KEY, JSON.stringify(next));
}

export function clearAlertLog() {
  return SecureStore.deleteItemAsync(LOG_KEY);
}
