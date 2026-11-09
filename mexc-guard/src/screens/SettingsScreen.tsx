import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getWidgetInfo, requestPinWidget, requestWidgetUpdate } from 'react-native-android-widget';

import { WidgetRefresher } from '../../modules/widget-refresher';
import { EXCHANGES, MEXC_BASE_URLS, type ExchangeId } from '../exchanges';
import { AlertSettingsSection } from '../components/AlertSettingsSection';
import { lockUnavailableReason, useAppLock } from '../components/AppLock';
import { Header } from '../components/Header';
import { setMenuHaptics, success } from '../haptics';
import { errorMessage } from '../hooks/useFutures';
import {
  clearCredentials,
  daysLeft,
  exchangeFor,
  KEY_LIFETIME_DAYS,
  loadCredentialsFor,
  saveCredentials,
  savedExchanges,
  setActiveExchange,
  type Credentials,
} from '../storage/credentials';
import { createStyles, colors, fmt, setGlass, useGlass } from '../theme';
import {
  LOCK_DELAYS,
  loadMenuHapticsEnabled,
  loadWidgetCloseEnabled,
  saveGlassEnabled,
  saveMenuHapticsEnabled,
  saveWidgetCloseEnabled,
} from '../storage/security';
import { PnlWidget, WIDGET_NAME } from '../widget/PnlWidget';
import { loadCachedSnapshot } from '../widget/snapshot';

interface Props {
  creds: Credentials | null;
  onSaved: (c: Credentials | null) => void;
}

const WIDGET_INTERVALS = [10, 15, 30, 60];

type TestResult = { ok: true; text: string } | { ok: false; text: string };

export function SettingsScreen({ creds: active, onSaved }: Props) {
  // The exchange being edited; its stored key (if any) fills the form.
  const [exchange, setExchange] = useState<ExchangeId>(active?.exchange ?? 'mexc');
  const [creds, setCreds] = useState<Credentials | null>(active);
  const [saved, setSaved] = useState<ExchangeId[]>([]);
  const [apiKey, setApiKey] = useState(active?.apiKey ?? '');
  const [secretKey, setSecretKey] = useState(active?.secretKey ?? '');
  const [baseUrl, setBaseUrl] = useState(active?.baseUrl ?? MEXC_BASE_URLS[0]);
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [liveWidget, setLiveWidget] = useState(() => WidgetRefresher.isEnabled());
  const [widgetInterval, setWidgetInterval] = useState(() => WidgetRefresher.getIntervalSec());
  const lock = useAppLock();
  const glass = useGlass();
  const toggleGlass = () => {
    success();
    setGlass(!glass);
    saveGlassEnabled(!glass).catch(() => {});
  };
  const [menuVibrate, setMenuVibrate] = useState(false);
  const toggleMenuVibrate = () => {
    const on = !menuVibrate;
    setMenuVibrate(on);
    setMenuHaptics(on);
    saveMenuHapticsEnabled(on).catch(() => {});
    if (on) success();
  };
  const [widgetClose, setWidgetClose] = useState(true);
  useEffect(() => {
    loadWidgetCloseEnabled().then(setWidgetClose);
    loadMenuHapticsEnabled().then(setMenuVibrate);
  }, []);

  const toggleLock = async () => {
    if (!lock) return;
    const on = !lock.settings.enabled;
    if (on) {
      const reason = await lockUnavailableReason();
      if (reason) return Alert.alert('Không bật được khóa', reason);
    }
    if (await lock.setEnabled(on)) success();
  };

  const toggleWidgetClose = async () => {
    const on = !widgetClose;
    await saveWidgetCloseEnabled(on);
    setWidgetClose(on);
    success();
    // Redraw the widget right away with or without its close buttons.
    const snap = await loadCachedSnapshot();
    requestWidgetUpdate({
      widgetName: WIDGET_NAME,
      renderWidget: (info) => <PnlWidget snap={snap} height={info.height} allowClose={on} />,
    }).catch(() => {});
  };

  useEffect(() => {
    savedExchanges().then(setSaved).catch(() => {});
  }, [active]);

  const pickExchange = async (id: ExchangeId) => {
    setExchange(id);
    setResult(null);
    const c = await loadCredentialsFor(id).catch(() => null);
    setCreds(c);
    setApiKey(c?.apiKey ?? '');
    setSecretKey(c?.secretKey ?? '');
    setBaseUrl(c?.baseUrl ?? MEXC_BASE_URLS[0]);
  };

  const useExchange = async () => {
    if (!creds) return;
    await setActiveExchange(exchange);
    success();
    onSaved(creds);
  };

  const meta = EXCHANGES.find((e) => e.id === exchange)!;
  const isActive = active?.exchange === exchange;

  const toggleLiveWidget = async () => {
    if (liveWidget) {
      WidgetRefresher.stop();
      setLiveWidget(false);
      return;
    }
    const placed = await getWidgetInfo(WIDGET_NAME).catch(() => []);
    if (!placed.length) {
      Alert.alert('Chưa có widget', 'Thêm widget "MEXC PnL" ra màn hình chính trước, rồi bật lại.');
      return;
    }
    WidgetRefresher.start(widgetInterval);
    setLiveWidget(true);
  };

  const changeWidgetInterval = (sec: number) => {
    setWidgetInterval(sec);
    if (liveWidget) WidgetRefresher.start(sec); // restarts with the new interval
  };

  const trimmed = { apiKey: apiKey.trim(), secretKey: secretKey.trim() };
  const valid = trimmed.apiKey.length > 0 && trimmed.secretKey.length > 0;
  const keyChanged = trimmed.apiKey !== creds?.apiKey || trimmed.secretKey !== creds?.secretKey;

  const paste = async (set: (v: string) => void) => set((await Clipboard.getStringAsync()).trim());

  const testConnection = async () => {
    setTesting(true);
    setResult(null);
    try {
      const api = exchangeFor(exchange, { exchange, ...trimmed, baseUrl, createdAt: 0 });
      const ping = await api.syncTime();
      const t0 = Date.now();
      const usdt = await api.getAccount();
      const authMs = Date.now() - t0;
      setResult({
        ok: true,
        text:
          `✓ Kết nối ${api.name} thành công\n` +
          `Ping: ${ping} ms · Request có ký: ${authMs} ms\n` +
          `Lệch giờ điện thoại: ${api.drift > 0 ? '+' : ''}${api.drift} ms (đã tự bù)\n` +
          `Số dư USDT khả dụng: ${fmt(usdt?.availableBalance)}`,
      });
    } catch (e) {
      setResult({ ok: false, text: `✗ ${errorMessage(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const c: Credentials = {
      exchange,
      ...trimmed,
      ...(exchange === 'mexc' && { baseUrl }),
      // A new key restarts the 90-day countdown.
      createdAt: keyChanged || !creds ? Date.now() : creds.createdAt,
    };
    await saveCredentials(c);
    await setActiveExchange(exchange);
    setCreds(c);
    success();
    onSaved(c);
    Alert.alert(`Đã lưu API Key ${meta.name}`, `${meta.name} là sàn đang dùng.`);
  };

  const addWidget = async () => {
    const ok = await requestPinWidget({ widgetName: WIDGET_NAME }).catch(() => false);
    if (!ok)
      Alert.alert(
        'Không thêm tự động được',
        'Giữ tay trên màn hình chính → Widget → tìm "MEXC PnL" và kéo ra màn hình.',
      );
  };

  const remove = () =>
    Alert.alert(`Xóa API Key ${meta.name} khỏi máy?`, 'Bạn sẽ cần nhập lại để dùng sàn này.', [
      { text: 'Không', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          await clearCredentials(exchange);
          setApiKey('');
          setSecretKey('');
          setResult(null);
          setCreds(null);
          const left = (await savedExchanges()).filter((id) => id !== exchange);
          setSaved(left);
          if (!isActive) return;
          // Fall back to another saved exchange, if any.
          const next = left.length ? await loadCredentialsFor(left[0]) : null;
          if (next) await setActiveExchange(next.exchange);
          onSaved(next);
        },
      },
    ]);

  return (
    <KeyboardAvoidingView style={styles.root} behavior="height">
      <Header title="Cài đặt sàn" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Sàn giao dịch</Text>
        <View style={styles.exRow}>
          {EXCHANGES.map((e) => {
            const on = e.id === exchange;
            const using = active?.exchange === e.id;
            return (
              <Pressable key={e.id} onPress={() => pickExchange(e.id)} style={[styles.exBtn, on && styles.exBtnOn]}>
                <Text style={[styles.exName, on && { color: colors.text }]}>{e.name}</Text>
                <Text style={[styles.exState, using && { color: colors.long }]}>
                  {using ? '● Đang dùng' : saved.includes(e.id) ? 'Đã lưu key' : 'Chưa có key'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {creds && !isActive && (
          <Pressable onPress={useExchange} style={[styles.button, styles.primary, { marginTop: 0 }]}>
            <Text style={styles.buttonText}>Chuyển sang dùng {meta.name}</Text>
          </Pressable>
        )}
        <Text style={styles.note}>
          {meta.keyHelp} Khóa chỉ được lưu mã hóa trên máy này (Android Keystore) và chỉ gửi chữ ký tới máy chủ {meta.name}.
          Không cấp quyền Rút tiền.
        </Text>

        <Text style={styles.label}>API Key (Access Key)</Text>
        <View style={styles.inputRow}>
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            style={styles.input}
            placeholder={exchange === 'mexc' ? 'mx0v...' : 'API Key'}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <SmallButton label="Dán" onPress={() => paste(setApiKey)} />
        </View>

        <Text style={styles.label}>Secret Key</Text>
        <View style={styles.inputRow}>
          <TextInput
            value={secretKey}
            onChangeText={setSecretKey}
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!showSecret}
          />
          <SmallButton label={showSecret ? 'Ẩn' : 'Hiện'} onPress={() => setShowSecret((s) => !s)} />
          <SmallButton label="Dán" onPress={() => paste(setSecretKey)} />
        </View>

        {exchange === 'mexc' && (
          <>
            <Text style={styles.label}>Máy chủ API Futures</Text>
            <View style={styles.inputRow}>
              {MEXC_BASE_URLS.map((u) => (
                <Pressable key={u} onPress={() => setBaseUrl(u)} style={[styles.chip, baseUrl === u && styles.chipActive]}>
                  <Text style={[styles.chipText, baseUrl === u && { color: colors.text }]}>{u.replace('https://', '')}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {creds && (
          <Text style={[styles.note, daysLeft(creds) <= 10 && { color: colors.warn }]}>
            Key lưu ngày {new Date(creds.createdAt).toLocaleDateString('vi-VN')} · Key không gắn IP hết hạn sau{' '}
            {KEY_LIFETIME_DAYS} ngày → còn {Math.max(daysLeft(creds), 0)} ngày.
          </Text>
        )}

        <Pressable
          onPress={testConnection}
          disabled={!valid || testing}
          style={[styles.button, styles.secondary, (!valid || testing) && styles.disabled]}
        >
          {testing ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>Kiểm tra kết nối</Text>}
        </Pressable>

        {result && (
          <View style={[styles.result, { borderColor: result.ok ? colors.long : colors.short }]}>
            <Text style={{ color: result.ok ? colors.long : colors.short, lineHeight: 20 }}>{result.text}</Text>
          </View>
        )}

        <Pressable onPress={save} disabled={!valid} style={[styles.button, styles.primary, !valid && styles.disabled]}>
          <Text style={styles.buttonText}>Lưu</Text>
        </Pressable>

        <Text style={styles.section}>Giao diện</Text>
        <Pressable onPress={toggleGlass} style={[styles.switchRow, { marginTop: 0 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>Liquid Glass</Text>
            <Text style={styles.switchSub}>Nền màu và các lớp kính trong suốt. Tắt để về giao diện tối đơn giản.</Text>
          </View>
          <View style={[styles.switchTrack, glass && styles.switchOn]}>
            <View style={[styles.switchThumb, glass && styles.switchThumbOn]} />
          </View>
        </Pressable>
        <Pressable onPress={toggleMenuVibrate} style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>Rung khi chuyển menu</Text>
            <Text style={styles.switchSub}>Rung nhẹ khi bấm hoặc lướt qua các mục của menu.</Text>
          </View>
          <View style={[styles.switchTrack, menuVibrate && styles.switchOn]}>
            <View style={[styles.switchThumb, menuVibrate && styles.switchThumbOn]} />
          </View>
        </Pressable>

        {creds && (
          <>
            <Text style={styles.section}>Widget PnL</Text>
            <Pressable onPress={addWidget} style={[styles.button, styles.secondary, { marginTop: 0 }]}>
              <Text style={styles.buttonText}>Thêm widget ra màn hình chính</Text>
            </Pressable>

            {WidgetRefresher.available && (
              <>
                <Pressable onPress={toggleLiveWidget} style={styles.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.switchTitle}>Tự cập nhật liên tục</Text>
                    <Text style={styles.switchSub}>
                      Chạy nền kể cả khi đóng app, có thông báo cố định. Tốn thêm pin và dữ liệu mạng.
                    </Text>
                  </View>
                  <View style={[styles.switchTrack, liveWidget && styles.switchOn]}>
                    <View style={[styles.switchThumb, liveWidget && styles.switchThumbOn]} />
                  </View>
                </Pressable>
                <View style={styles.inputRow}>
                  {WIDGET_INTERVALS.map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => changeWidgetInterval(s)}
                      style={[styles.chip, widgetInterval === s && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, widgetInterval === s && { color: colors.text }]}>{s}s</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
          </>
        )}

        {creds && lock && (
          <>
            <Text style={styles.section}>Bảo mật</Text>
            <Pressable onPress={toggleLock} style={[styles.switchRow, { marginTop: 0 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchTitle}>Khóa app bằng vân tay</Text>
                <Text style={styles.switchSub}>
                  Hỏi vân tay / khuôn mặt (hoặc mã khóa máy) khi mở app. Bật hoặc tắt đều phải xác thực.
                </Text>
              </View>
              <View style={[styles.switchTrack, lock.settings.enabled && styles.switchOn]}>
                <View style={[styles.switchThumb, lock.settings.enabled && styles.switchThumbOn]} />
              </View>
            </Pressable>
            {lock.settings.enabled && (
              <>
                <Text style={[styles.switchSub, { marginBottom: 8 }]}>Khóa lại khi rời app quá:</Text>
                <View style={styles.inputRow}>
                  {LOCK_DELAYS.map((d) => (
                    <Pressable
                      key={d}
                      onPress={() => lock.setDelay(d)}
                      style={[styles.chip, lock.settings.delaySec === d && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, lock.settings.delaySec === d && { color: colors.text }]}>
                        {d === 0 ? 'Ngay lập tức' : d < 60 ? `${d} giây` : `${d / 60} phút`}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}

            <Pressable onPress={toggleWidgetClose} style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchTitle}>Nút đóng lệnh trên widget</Text>
                <Text style={styles.switchSub}>
                  Widget không hỏi được vân tay: ai cầm máy đã mở khóa cũng đóng được lệnh. Tắt để widget chỉ hiển thị.
                </Text>
              </View>
              <View style={[styles.switchTrack, widgetClose && styles.switchOn]}>
                <View style={[styles.switchThumb, widgetClose && styles.switchThumbOn]} />
              </View>
            </Pressable>
          </>
        )}

        {creds && <AlertSettingsSection />}

        {creds && (
          <Pressable onPress={remove} style={[styles.button, styles.danger]}>
            <Text style={[styles.buttonText, { color: colors.short }]}>Xóa API Key khỏi máy</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SmallButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.small}>
      <Text style={styles.smallText}>{label}</Text>
    </Pressable>
  );
}

const styles = createStyles({
  root: { flex: 1, backgroundColor: colors.page },
  exRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  exBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  exBtnOn: { borderColor: colors.warn, backgroundColor: colors.cardAlt },
  exName: { color: colors.muted, fontSize: 15, fontWeight: '800' },
  exState: { color: colors.muted, fontSize: 10.5, marginTop: 2 },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  section: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 28, marginBottom: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, marginBottom: 10 },
  switchTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  switchSub: { color: colors.muted, fontSize: 12, marginTop: 3, lineHeight: 17 },
  switchTrack: { width: 46, height: 26, borderRadius: 13, backgroundColor: colors.cardAlt, padding: 3 },
  switchOn: { backgroundColor: colors.long },
  switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.muted },
  switchThumbOn: { backgroundColor: colors.text, marginLeft: 20 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19, marginVertical: 8 },
  label: { color: colors.muted, fontSize: 13, marginTop: 14, marginBottom: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    height: 48,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 15,
  },
  small: {
    height: 48,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    justifyContent: 'center',
  },
  smallText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  chip: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: { borderColor: colors.warn, backgroundColor: colors.warn + '18' },
  chipText: { color: colors.muted, fontSize: 13 },
  button: { height: 52, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.muted },
  danger: { borderWidth: 1, borderColor: colors.short },
  disabled: { opacity: 0.4 },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  result: { marginTop: 12, padding: 12, borderRadius: 8, borderWidth: 1, backgroundColor: colors.card },
});
