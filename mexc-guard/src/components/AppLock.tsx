import * as LocalAuthentication from 'expo-local-authentication';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';

import { loadLockSettings, saveLockSettings, type LockSettings } from '../storage/security';
import { createStyles, colors } from '../theme';

// The device no longer has any fingerprint or screen lock: nothing to check against, and
// refusing would lock the user out of the app for good.
const NO_DEVICE_LOCK = new Set(['not_enrolled', 'passcode_not_set', 'not_available']);

/** Fingerprint / face prompt with the device PIN as fallback. Resolves true on success. */
export async function authenticate(promptMessage = 'Mở khóa MEXC Guard') {
  const res = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: 'Hủy',
    disableDeviceFallback: false,
  });
  return res.success || NO_DEVICE_LOCK.has(res.error);
}

/** Why the lock cannot be turned on, or null when the device supports it. */
export async function lockUnavailableReason() {
  if (!(await LocalAuthentication.hasHardwareAsync())) return 'Máy không có cảm biến vân tay / khuôn mặt.';
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE)
    return 'Chưa cài vân tay hoặc mã khóa màn hình trong Cài đặt của máy.';
  return null;
}

interface LockApi {
  settings: LockSettings;
  /** Turning the lock on or off asks for the fingerprint first. Returns whether it changed. */
  setEnabled: (on: boolean) => Promise<boolean>;
  setDelay: (sec: number) => Promise<void>;
}

const LockContext = createContext<LockApi | null>(null);
export const useAppLock = () => useContext(LockContext);

/**
 * Covers the app with a lock screen at start and when it comes back from the background after
 * `delaySec`. The app stays mounted underneath, so data and open screens are kept.
 */
export function AppLockProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<LockSettings | null>(null);
  const [locked, setLocked] = useState(true);
  const authing = useRef(false);
  const backgroundAt = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const unlock = useCallback(async () => {
    if (authing.current) return;
    authing.current = true;
    try {
      if (await authenticate()) setLocked(false);
    } finally {
      authing.current = false;
    }
  }, []);

  // Initial state: locked only when the feature is on.
  useEffect(() => {
    loadLockSettings().then((s) => {
      setSettings(s);
      if (s.enabled) unlock();
      else setLocked(false);
    });
  }, [unlock]);

  // Re-lock after the app was in the background long enough. The system prompt itself only makes
  // the app "inactive", and `authing` guards against re-prompting while it is shown.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const s = settingsRef.current;
      if (!s?.enabled || authing.current) return;
      if (state === 'background') backgroundAt.current = Date.now();
      else if (state === 'active' && backgroundAt.current !== null) {
        const away = Date.now() - backgroundAt.current;
        backgroundAt.current = null;
        if (away >= s.delaySec * 1000) {
          setLocked(true);
          unlock();
        }
      }
    });
    return () => sub.remove();
  }, [unlock]);

  const update = useCallback(async (next: LockSettings) => {
    await saveLockSettings(next);
    setSettings(next);
  }, []);

  const api: LockApi | null = settings && {
    settings,
    setEnabled: async (on) => {
      if (on === settings.enabled) return false;
      authing.current = true;
      try {
        if (!(await authenticate(on ? 'Xác nhận bật khóa vân tay' : 'Xác nhận tắt khóa vân tay'))) return false;
      } finally {
        authing.current = false;
      }
      await update({ ...settings, enabled: on });
      return true;
    },
    setDelay: (delaySec) => update({ ...settings, delaySec }),
  };

  return (
    <LockContext.Provider value={api}>
      <View style={{ flex: 1 }}>
        {settings && children}
        {(locked || !settings) && (
          <View style={styles.overlay}>
            {settings && (
              <>
                <Text style={styles.icon}>🔒</Text>
                <Text style={styles.title}>MEXC Guard đang khóa</Text>
                <Text style={styles.sub}>Xác thực bằng vân tay hoặc mã khóa máy để tiếp tục.</Text>
                <Pressable onPress={unlock} style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}>
                  <Text style={styles.buttonText}>Mở khóa</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </View>
    </LockContext.Provider>
  );
}

const styles = createStyles({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  icon: { fontSize: 48 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 16 },
  sub: { color: colors.muted, fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  button: {
    marginTop: 28,
    height: 50,
    paddingHorizontal: 40,
    borderRadius: 12,
    backgroundColor: colors.warn,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: colors.bg, fontSize: 16, fontWeight: '800' },
});
