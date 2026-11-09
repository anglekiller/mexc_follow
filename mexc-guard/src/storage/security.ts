import * as SecureStore from 'expo-secure-store';

const LOCK_KEY = 'app_lock_v1';
const WIDGET_CLOSE_KEY = 'widget_close_enabled_v1';
const GLASS_KEY = 'glass_enabled_v1';
const MENU_HAPTICS_KEY = 'menu_haptics_enabled_v1';

export async function loadGlassEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(GLASS_KEY)) === '1';
  } catch {
    return false;
  }
}

export function saveGlassEnabled(on: boolean) {
  return SecureStore.setItemAsync(GLASS_KEY, on ? '1' : '0');
}

export async function loadMenuHapticsEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(MENU_HAPTICS_KEY)) === '1';
  } catch {
    return false;
  }
}

export function saveMenuHapticsEnabled(on: boolean) {
  return SecureStore.setItemAsync(MENU_HAPTICS_KEY, on ? '1' : '0');
}

export interface LockSettings {
  enabled: boolean;
  /** Seconds the app may stay in the background before it locks again (0 = always). */
  delaySec: number;
}

export const LOCK_DELAYS = [0, 30, 300];
const DEFAULT_LOCK: LockSettings = { enabled: false, delaySec: 30 };

export async function loadLockSettings(): Promise<LockSettings> {
  try {
    const json = await SecureStore.getItemAsync(LOCK_KEY);
    return json ? { ...DEFAULT_LOCK, ...(JSON.parse(json) as Partial<LockSettings>) } : DEFAULT_LOCK;
  } catch {
    return DEFAULT_LOCK;
  }
}

export function saveLockSettings(s: LockSettings) {
  return SecureStore.setItemAsync(LOCK_KEY, JSON.stringify(s));
}

/** Whether the home-screen widget may close positions (it cannot ask for a fingerprint). */
export async function loadWidgetCloseEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(WIDGET_CLOSE_KEY)) !== '0';
  } catch {
    return true;
  }
}

export function saveWidgetCloseEnabled(on: boolean) {
  return SecureStore.setItemAsync(WIDGET_CLOSE_KEY, on ? '1' : '0');
}
