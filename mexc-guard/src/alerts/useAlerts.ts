import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { Futures } from '../hooks/useFutures';
import { runAlerts, type WatchedPosition } from './engine';
import { loadAlertLog, type AlertEntry } from './log';
import { checkSignals } from '../signals/background';
import { toWatched } from './watch';

const MIN_INTERVAL_MS = 15_000;

/** While the app is open: run the position alerts on the live data and expose the alert log. */
export function useAlerts(f: Futures) {
  const [log, setLog] = useState<AlertEntry[]>([]);
  const last = useRef(0);

  const reload = useCallback(() => {
    loadAlertLog().then(setLog);
  }, []);
  useEffect(() => {
    reload();
    // Alerts raised in the background (widget service) show up when the app comes back.
    const sub = AppState.addEventListener('change', (s) => s === 'active' && reload());
    return () => sub.remove();
  }, [reload]);

  useEffect(() => {
    const api = f.api;
    if (!api || !f.lastUpdate) return;
    const now = Date.now();
    if (now - last.current < MIN_INTERVAL_MS) return;
    last.current = now;
    const watched = f.positions
      .map((p) => toWatched(api, p, p.mark, p.contract, f.orders))
      .filter((w): w is WatchedPosition => w !== null);
    runAlerts(api, watched)
      .then((n) => n > 0 && reload())
      .catch(() => {});
    // Entry signals (gold / silver / oil); throttled inside to every 5 minutes.
    checkSignals(api)
      .then(reload)
      .catch(() => {});
  }, [f.lastUpdate, f.api, f.positions, f.orders, reload]);

  return { log, reload };
}

export type Alerts = ReturnType<typeof useAlerts>;
