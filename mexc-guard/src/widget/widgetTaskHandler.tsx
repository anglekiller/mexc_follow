import type { WidgetTaskHandlerProps } from 'react-native-android-widget';

import {
  ALL_TARGET,
  CLOSE_ACTION,
  CLOSE_CONFIRM_ACTION,
  CLOSE_WINDOW_MS,
  PnlWidget,
  REFRESH_ACTION,
  WIDGET_NAME,
} from './PnlWidget';
import { loadWidgetCloseEnabled } from '../storage/security';
import { checkAlertsAfterFetch, closeOnePosition, fetchSnapshot, loadCachedSnapshot, panicCloseAll, type Snapshot } from './snapshot';

const ACTIONS = new Set([REFRESH_ACTION, CLOSE_ACTION, CLOSE_CONFIRM_ACTION]);

// Close confirmation state. The headless JS runtime lives on between widget events while the
// process does, so module state is enough for a 5 s window; if the process died in between, the
// second tap simply arms again.
let armed: { target: string; at: number } | null = null;
let running: string | null = null;
const armedTarget = () => (armed && Date.now() - armed.at < CLOSE_WINDOW_MS ? armed.target : null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (msg: string, max = 26) => (msg.length > max ? `${msg.slice(0, max - 1)}…` : msg);

/** Runs headless (app may be closed): added, periodic update, resize, ⟳ and the close buttons. */
export async function widgetTaskHandler({
  widgetInfo,
  widgetAction,
  clickAction,
  clickActionData,
  renderWidget,
}: WidgetTaskHandlerProps) {
  if (widgetInfo.widgetName !== WIDGET_NAME || widgetAction === 'WIDGET_DELETED') return;
  if (widgetAction === 'WIDGET_CLICK' && !ACTIONS.has(clickAction ?? '')) return;

  const height = widgetInfo.height;
  const [cached, allowClose] = await Promise.all([loadCachedSnapshot(), loadWidgetCloseEnabled()]);
  const render = (snap: Snapshot | null = cached, status?: string) =>
    renderWidget(
      <PnlWidget
        snap={snap}
        status={status}
        height={height}
        armed={armedTarget()}
        running={running}
        allowClose={allowClose}
      />,
    );

  if (widgetAction === 'WIDGET_RESIZED') return render();

  const target = typeof clickActionData?.target === 'string' ? clickActionData.target : null;
  if (widgetAction === 'WIDGET_CLICK' && target && (clickAction === CLOSE_ACTION || clickAction === CLOSE_CONFIRM_ACTION)) {
    // Turned off in Settings while an old rendering with buttons was still on screen.
    if (running || !allowClose) return render();

    // First tap (or the confirm came too late / for another row): arm, then disarm if not confirmed.
    if (clickAction === CLOSE_ACTION || armedTarget() !== target) {
      const mine = { target, at: Date.now() };
      armed = mine;
      render();
      await sleep(CLOSE_WINDOW_MS);
      if (armed === mine && !running) {
        armed = null;
        render();
      }
      return;
    }

    // Confirmed.
    armed = null;
    running = target;
    render();
    let status: string;
    try {
      if (target === ALL_TARGET) {
        const { closed, errors } = await panicCloseAll();
        status = errors.length ? `Lỗi ${errors.length}: ${errors[0]}` : `Đã đóng ${closed} vị thế`;
      } else {
        status = `Đã đóng ${await closeOnePosition(target)}`;
      }
    } catch (e) {
      status = e instanceof Error ? e.message : 'Lỗi';
    } finally {
      running = null;
    }
    // Show the result with fresh data; positions can take a moment to disappear on the exchange.
    await sleep(1_000);
    const fresh = await fetchSnapshot().catch(() => cached);
    return render(fresh, short(status));
  }

  // Only a manual ⟳ shows progress; periodic refreshes (every few seconds) would just flicker.
  if (widgetAction === 'WIDGET_CLICK') render(cached, 'Đang cập nhật…');
  try {
    render(await fetchSnapshot());
    // Position alerts (also while the app is closed), after the widget is drawn.
    await checkAlertsAfterFetch().catch(() => {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Lỗi';
    render(cached, msg.length > 24 ? 'Lỗi kết nối' : msg);
  }
}
