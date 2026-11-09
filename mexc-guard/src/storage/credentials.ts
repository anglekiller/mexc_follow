import * as SecureStore from 'expo-secure-store';

import { createExchange } from '../exchanges';
import type { ExchangeCredentials, ExchangeId } from '../exchanges/types';
import { hmacSha256 } from '../api/hmac';

// Stored only on-device in the Android Keystore-backed SecureStore; sent nowhere but the exchange.
// One entry per exchange plus the active one. The pre-multi-exchange MEXC key is migrated.
const LEGACY_KEY = 'mexc_credentials_v1';
const keyOf = (id: ExchangeId) => `creds_${id}_v1`;
const ACTIVE_KEY = 'active_exchange_v1';

export const KEY_LIFETIME_DAYS = 90;
export const KEY_WARN_DAYS = 10;

export type Credentials = ExchangeCredentials;

async function read(id: ExchangeId): Promise<Credentials | null> {
  let json = await SecureStore.getItemAsync(keyOf(id));
  if (!json && id === 'mexc') {
    json = await SecureStore.getItemAsync(LEGACY_KEY);
    if (json) {
      await SecureStore.setItemAsync(keyOf('mexc'), json);
      await SecureStore.deleteItemAsync(LEGACY_KEY);
    }
  }
  if (!json) return null;
  try {
    return { ...(JSON.parse(json) as Credentials), exchange: id };
  } catch {
    return null;
  }
}

export async function getActiveExchange(): Promise<ExchangeId> {
  const v = await SecureStore.getItemAsync(ACTIVE_KEY);
  return v === 'binance' || v === 'bingx' ? v : 'mexc';
}

export const setActiveExchange = (id: ExchangeId) => SecureStore.setItemAsync(ACTIVE_KEY, id);

/** Credentials of the active exchange. */
export async function loadCredentials(): Promise<Credentials | null> {
  return read(await getActiveExchange());
}

export const loadCredentialsFor = read;

export async function savedExchanges(): Promise<ExchangeId[]> {
  const ids: ExchangeId[] = ['mexc', 'binance', 'bingx'];
  const have = await Promise.all(ids.map((id) => read(id)));
  return ids.filter((_, i) => have[i]);
}

export function saveCredentials(c: Credentials) {
  return SecureStore.setItemAsync(keyOf(c.exchange), JSON.stringify(c));
}

export function clearCredentials(id: ExchangeId) {
  return SecureStore.deleteItemAsync(keyOf(id));
}

export function daysLeft(c: Credentials, now = Date.now()) {
  return KEY_LIFETIME_DAYS - Math.floor((now - c.createdAt) / 86_400_000);
}

/** Exchange client for stored credentials (or public-only without them). */
export const exchangeFor = (id: ExchangeId, c: Credentials | null) => createExchange(id, hmacSha256, c);
