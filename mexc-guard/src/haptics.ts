import * as Haptics from 'expo-haptics';

// Fire-and-forget: haptics must never break an action.
export const tap = () => Haptics.selectionAsync().catch(() => {});

let menuHaptics = false;
export const setMenuHaptics = (on: boolean) => {
  menuHaptics = on;
};
/** Feedback for switching menu items: only when enabled in the settings. */
export const menuTap = () => {
  if (menuHaptics) tap();
};

export const heavy =() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
export const success = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
export const failure = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
