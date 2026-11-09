import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const CHANNEL = 'position-alerts';

// Show alerts as banners even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let channelReady = false;
async function ensureChannel() {
  if (channelReady || Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Nhắc nhở vị thế',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
  });
  channelReady = true;
}

/** Asks for notification permission (Android 13+). Returns whether notifications may be shown. */
export async function requestNotificationPermission() {
  await ensureChannel();
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function showNotification(title: string, body: string) {
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
  });
}
