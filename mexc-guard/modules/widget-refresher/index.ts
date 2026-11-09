import { requireOptionalNativeModule } from 'expo';

interface WidgetRefresherModule {
  /** Start the foreground service that refreshes the PnL widget every `intervalSec` seconds. */
  start(intervalSec: number): void;
  stop(): void;
  isEnabled(): boolean;
  getIntervalSec(): number;
}

// Optional so the JS bundle still loads on builds without the native module.
const native = requireOptionalNativeModule<WidgetRefresherModule>('WidgetRefresher');

export const WidgetRefresher = {
  available: native !== null,
  start: (intervalSec: number) => native?.start(intervalSec),
  stop: () => native?.stop(),
  isEnabled: () => native?.isEnabled() ?? false,
  getIntervalSec: () => native?.getIntervalSec() ?? 15,
};
