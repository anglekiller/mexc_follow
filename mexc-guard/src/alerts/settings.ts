import * as SecureStore from 'expo-secure-store';

export interface AlertSettings {
  enabled: boolean;
  /** Ask Gemini to write the analysis / suggestion of each alert. */
  aiEnabled: boolean;
  /** Gemini model resource name, e.g. "models/gemini-…-flash". */
  model: string;
  /** Every usable model of the key (from the last "Kiểm tra"), used as fallbacks when overloaded. */
  models: string[];
  /** Price move (percent) within 5 minutes that counts as a sharp move. */
  movePct: number;
  /** ROE (percent, positive number) at which a losing position is flagged. */
  lossRoe: number;
}

export const MOVE_OPTIONS = [0.5, 1, 2, 3];
export const LOSS_OPTIONS = [30, 50, 80];

const SETTINGS_KEY = 'alerts_settings_v1';
const GEMINI_KEY = 'gemini_api_key_v1';

const DEFAULTS: AlertSettings = { enabled: false, aiEnabled: true, model: '', models: [], movePct: 1, lossRoe: 50 };

export async function loadAlertSettings(): Promise<AlertSettings> {
  try {
    const json = await SecureStore.getItemAsync(SETTINGS_KEY);
    return json ? { ...DEFAULTS, ...(JSON.parse(json) as Partial<AlertSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveAlertSettings(s: AlertSettings) {
  return SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(s));
}

export async function loadGeminiKey() {
  try {
    return (await SecureStore.getItemAsync(GEMINI_KEY)) ?? '';
  } catch {
    return '';
  }
}

export function saveGeminiKey(key: string) {
  return key ? SecureStore.setItemAsync(GEMINI_KEY, key) : SecureStore.deleteItemAsync(GEMINI_KEY);
}
