import { useEffect, useRef } from 'react';
import { requestWidgetUpdate } from 'react-native-android-widget';

import type { Futures } from '../hooks/useFutures';
import { PnlWidget, WIDGET_NAME } from './PnlWidget';
import { loadWidgetCloseEnabled } from '../storage/security';
import { cacheSnapshot, type Snapshot } from './snapshot';

// Each push reads the keystore and renders a bitmap: costly on older phones while the app is open.
const MIN_INTERVAL_MS = 10_000;

/** While the app is open, mirror its live data onto the home-screen widget (throttled). */
export function useWidgetSync(f: Futures) {
  const lastPush = useRef(0);

  useEffect(() => {
    if (!f.lastUpdate || !f.asset || f.positions.some((p) => p.pnl === undefined)) return;
    const now = Date.now();
    if (now - lastPush.current < MIN_INTERVAL_MS) return;
    lastPush.current = now;

    const snap: Snapshot = {
      equity: f.asset.equity,
      unrealized: f.unrealized,
      positions: f.positions.map((p) => ({
        id: p.positionId,
        symbol: p.symbol,
        name: f.api?.baseOf(p.symbol),
        long: p.positionType === 1,
        leverage: p.leverage,
        pnl: p.pnl!,
        roe: p.roe,
      })),
      time: now,
      exchange: f.api?.name,
    };
    cacheSnapshot(snap);
    loadWidgetCloseEnabled().then((allowClose) =>
      requestWidgetUpdate({
        widgetName: WIDGET_NAME,
        renderWidget: (info) => <PnlWidget snap={snap} height={info.height} allowClose={allowClose} />,
      }).catch(() => {}),
    );
  }, [f.lastUpdate, f.asset, f.positions, f.unrealized, f.api]);
}
