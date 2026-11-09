import { Alert, type AlertButton } from 'react-native';

// react-native-web's Alert.alert does nothing, which would silently swallow every order
// confirmation. Native dialogs block until answered; dismissing one always means "cancel".
Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  const text = message ? `${title}\n\n${message}` : title;
  if (!buttons || buttons.length <= 1) {
    window.alert(text);
    buttons?.[0]?.onPress?.();
    return;
  }
  const cancel = buttons.find((b) => b.style === 'cancel');
  const actions = buttons.filter((b) => b !== cancel);
  for (const action of actions) {
    if (window.confirm(`${text}\n\nBấm OK để: ${action.text ?? 'Đồng ý'}`)) {
      action.onPress?.();
      return;
    }
  }
  cancel?.onPress?.();
};
