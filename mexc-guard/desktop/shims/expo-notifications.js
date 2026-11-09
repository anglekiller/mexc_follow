// Alerts appear as Windows notifications.
export const AndroidImportance = { HIGH: 4 };
export const setNotificationHandler = () => {};
export const setNotificationChannelAsync = async () => {};

const status = () => ({ granted: Notification.permission !== 'denied' });
export const getPermissionsAsync = async () => status();
export const requestPermissionsAsync = async () => ({ granted: (await Notification.requestPermission()) !== 'denied' });

export const scheduleNotificationAsync = async ({ content }) => {
  new Notification(content.title, { body: content.body });
  return String(Date.now());
};
