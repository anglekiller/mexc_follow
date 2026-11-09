import './src/platform/alertPolyfill';

import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppLockProvider } from './src/components/AppLock';
import { GlassBackdrop } from './src/components/GlassEffects';
import { setMenuHaptics } from './src/haptics';
import { MainScreen } from './src/screens/MainScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { loadCredentials, type Credentials } from './src/storage/credentials';
import { loadGlassEnabled, loadMenuHapticsEnabled } from './src/storage/security';
import { colors, setGlass, useGlass } from './src/theme';

function Root() {
  useGlass(); // Re-renders the whole tree with the other style set when the mode changes.
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState(false);
  const [creds, setCreds] = useState<Credentials | null>(null);

  useEffect(() => {
    loadCredentials()
      .then(setCreds)
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  // First run: only the API setup screen.
  if (!creds) {
    return (
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <SettingsScreen creds={null} onSaved={setCreds} />
      </View>
    );
  }

  return <MainScreen creds={creds} onCredsChange={setCreds} />;
}

export default function App() {
  useEffect(() => {
    loadGlassEnabled().then(setGlass);
    loadMenuHapticsEnabled().then(setMenuHaptics);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <GlassBackdrop />
        <AppLockProvider>
          <Root />
        </AppLockProvider>
      </View>
    </SafeAreaProvider>
  );
}
