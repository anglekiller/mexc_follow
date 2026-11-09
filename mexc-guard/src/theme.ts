import { useSyncExternalStore } from 'react';
import { Dimensions, PixelRatio, StyleSheet } from 'react-native';

// Layout is designed for a 400dp-wide screen at 100% font size. Narrower screens shrink
// proportionally, and the system font scale is neutralised so text keeps the designed proportions.
export const UI_SCALE = Math.min(1, Math.max(0.8, Dimensions.get('window').width / 400));
const fontScale = PixelRatio.getFontScale() || 1;

export const sz = (n: number) => Math.round(n * UI_SCALE);
export const fs = (n: number) => Math.round(((n * UI_SCALE) / fontScale) * 2) / 2;

const FONT_KEYS = new Set(['fontSize', 'lineHeight']);
const SIZE_KEY = /^(width|height|minWidth|minHeight|maxWidth|maxHeight|padding|margin|gap|rowGap|columnGap|top|bottom|left|right)|Radius$/;

// Glass mode: switching only re-renders, so tabs, sockets and the app lock keep their state.
let glass = false;
const glassListeners = new Set<() => void>();

const isGlass = () => glass;
const subscribeGlass = (listener: () => void) => {
  glassListeners.add(listener);
  return () => {
    glassListeners.delete(listener);
  };
};

export function setGlass(on: boolean) {
  if (on === glass) return;
  glass = on;
  glassListeners.forEach((l) => l());
}

/** Re-renders the caller when glass mode changes. Components wrapped in memo() must call this. */
export const useGlass = () => useSyncExternalStore(subscribeGlass, isGlass);

/** StyleSheet.create with fonts and dimensions scaled for the current screen (borders untouched). */
type Styles = Parameters<typeof StyleSheet.create>[0];

function toGlass(style: Record<string, unknown>) {
  const out = { ...style };
  for (const key of ['backgroundColor', 'borderColor']) {
    const surface = GLASS_SURFACES[out[key] as string];
    if (surface) out[key] = surface;
  }
  if (out.color === colors.muted) out.color = GLASS_MUTED;
  // Every pane gets the bright rim that makes it read as glass.
  if (style.backgroundColor === colors.card && !Object.keys(style).some((k) => /^border.*Width$/.test(k))) {
    // Lit from above: bright top edge, dim bottom edge.
    out.borderWidth = 1;
    out.borderTopColor = 'rgba(255,255,255,0.50)';
    out.borderLeftColor = 'rgba(255,255,255,0.26)';
    out.borderRightColor = 'rgba(255,255,255,0.14)';
    out.borderBottomColor = 'rgba(255,255,255,0.10)';
  }
  return out;
}

export function createStyles<T extends Styles>(styles: T & Styles): Readonly<T> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, style] of Object.entries(styles as Record<string, Record<string, unknown>>)) {
    out[name] = Object.fromEntries(
      Object.entries(style).map(([k, v]) => [
        k,
        typeof v !== 'number' ? v : FONT_KEYS.has(k) ? fs(v) : SIZE_KEY.test(k) ? sz(v) : v,
      ]),
    );
  }
  const solid: Record<string, unknown> = StyleSheet.create(out as never);
  const glassy: Record<string, unknown> = StyleSheet.create(
    Object.fromEntries(Object.entries(out).map(([name, style]) => [name, toGlass(style)])) as never,
  );
  const result = {};
  for (const name of Object.keys(out)) {
    Object.defineProperty(result, name, { enumerable: true, get: () => (glass ? glassy : solid)[name] });
  }
  return result as unknown as T;
}

export const colors = {
  bg: '#121212',
  /** Tab screen background: looks like bg, but lets the backdrop through in glass mode. */
  page: '#121212FF',
  card: '#1E1E1E',
  /** Looks like card, but stays opaque in glass mode: popups and tooltips over busy content. */
  sheet: '#1E1E1EFF',
  cardAlt: '#262626',
  border: '#2E2E2E',
  text: '#FFFFFF',
  muted: '#8A8F98',
  long: '#00C087',
  short: '#F6465D',
  warn: '#F0B90B',
  accent: '#2E7CF6',
};

const GLASS_SURFACES: Record<string, string> = {
  [colors.bg]: '#0B1120',
  [colors.page]: 'transparent',
  [colors.card]: 'rgba(255,255,255,0.11)',
  [colors.cardAlt]: 'rgba(255,255,255,0.16)',
  [colors.border]: 'rgba(255,255,255,0.20)',
  [colors.sheet]: '#1B2438',
};
const GLASS_MUTED = '#A9B1BF';

export const pnlColor = (n: number) => (n > 0 ? colors.long : n < 0 ? colors.short : colors.text);

/** Fixed decimals with thousands separators (no Intl dependency). */
export function fmt(n: number | undefined | null, decimals = 2) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const [int, frac] = Math.abs(n).toFixed(decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** Order size in the exchange's unit: contracts on MEXC ("12 cont"), coins elsewhere ("0.015 XAU"). */
export function fmtVol(vol: number | undefined, c?: { volScale: number; baseCoin: string; contractSize: number } | null) {
  if (vol === undefined || !Number.isFinite(vol)) return '—';
  if (!c || c.contractSize !== 1) return `${fmt(vol, c?.volScale ?? 0)} cont`;
  return `${fmt(vol, c.volScale)} ${c.baseCoin}`;
}

/** "BTC_USDT" / "BTC-USDT" / "BTCUSDT" → "BTCUSDT" style label. */
export const pairLabel = (symbol: string) => symbol.replace(/[_-]/g, '');

export const signed = (n: number, decimals = 2) => `${n > 0 ? '+' : ''}${fmt(n, decimals)}`;

/** Chart time label: intraday -> "dd/MM HH:mm", daily and up -> "dd/MM/yy". */
export function fmtChartTime(sec: number, intervalSec: number) {
  const d = new Date(sec * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  const day = `${p(d.getDate())}/${p(d.getMonth() + 1)}`;
  return intervalSec >= 86400 ? `${day}/${String(d.getFullYear()).slice(2)}` : `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtTime(ms: number) {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getDate())}/${p(d.getMonth() + 1)}`;
}
