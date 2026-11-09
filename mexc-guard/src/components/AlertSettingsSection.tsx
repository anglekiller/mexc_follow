import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { sendTestAlert } from '../alerts/engine';
import { familyOf, listModels, type GeminiModel, type ModelFamily } from '../alerts/gemini';
import { requestNotificationPermission } from '../alerts/notify';
import {
  LOSS_OPTIONS,
  MOVE_OPTIONS,
  loadAlertSettings,
  loadGeminiKey,
  saveAlertSettings,
  saveGeminiKey,
  type AlertSettings,
} from '../alerts/settings';
import { success } from '../haptics';
import { createStyles, colors } from '../theme';
import { WidgetRefresher } from '../../modules/widget-refresher';

/** Settings → "AI nhắc nhở": rules, thresholds, Gemini key and model. */
export function AlertSettingsSection() {
  const [s, setS] = useState<AlertSettings | null>(null);
  const [key, setKey] = useState('');
  const [savedKey, setSavedKey] = useState('');
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    (async () => {
      const [st, k] = await Promise.all([loadAlertSettings(), loadGeminiKey()]);
      setS(st);
      setKey(k);
      setSavedKey(k);
      if (!k) return;
      // Refresh the model list quietly (also fills the fallback list of older settings).
      const list = await listModels(k).catch(() => null);
      if (!list?.length) return;
      setModels(list);
      const names = list.map((m) => m.name);
      const current = list.find((m) => m.name === st.model);
      // First run after the update: a preview model was auto-picked before — move to a stable one.
      const model = !current || (current.preview && !st.models.length) ? list[0].name : st.model;
      const next = { ...st, model, models: names };
      setS(next);
      await saveAlertSettings(next);
    })();
  }, []);

  if (!s) return null;

  const update = async (patch: Partial<AlertSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    await saveAlertSettings(next);
  };

  const toggle = async () => {
    if (!s.enabled && !(await requestNotificationPermission())) {
      return Alert.alert('Chưa cho phép thông báo', 'Bật quyền thông báo cho MEXC Guard trong Cài đặt của máy.');
    }
    await update({ enabled: !s.enabled });
    success();
  };

  const checkKey = async () => {
    const k = key.trim();
    if (!k) return Alert.alert('Nhập Gemini API key', 'Lấy key miễn phí tại aistudio.google.com → Get API key.');
    setChecking(true);
    try {
      const list = await listModels(k);
      if (!list.length) throw new Error('Key không dùng được model văn bản nào.');
      await saveGeminiKey(k);
      setSavedKey(k);
      setModels(list);
      await update({
        models: list.map((m) => m.name),
        model: list.some((m) => m.name === s.model) ? s.model : list[0].name,
      });
      success();
    } catch (e) {
      Alert.alert('Key Gemini không hợp lệ', e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const removeKey = async () => {
    await saveGeminiKey('');
    setKey('');
    setSavedKey('');
    setModels([]);
    await update({ model: '', models: [] });
  };

  const test = async () => {
    if (!(await requestNotificationPermission())) return Alert.alert('Chưa cho phép thông báo');
    setTesting(true);
    try {
      const res = await sendTestAlert(null, null, s);
      Alert.alert(
        'Đã gửi nhắc nhở thử',
        res
          ? `${res.model.replace('models/', '')} trả lời${res.model !== s.model ? ' (model chính quá tải, đã dùng model dự phòng)' : ''}:\n\n${res.text}`
          : 'Không dùng Gemini (chưa có key / đang tắt).',
      );
    } catch (e) {
      Alert.alert('Gửi thử thất bại', e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const shownModels: GeminiModel[] = models.length
    ? models
    : s.model
      ? [{ name: s.model, displayName: s.model.replace('models/', ''), family: familyOf(s.model), preview: false }]
      : [];
  const groups = FAMILIES.map((f) => ({ ...f, list: shownModels.filter((m) => m.family === f.family) })).filter((g) => g.list.length);

  return (
    <View>
      <Text style={styles.section}>AI nhắc nhở vị thế</Text>
      <Switch
        on={s.enabled}
        onPress={toggle}
        title="Bật nhắc nhở"
        sub="Cảnh báo khi giá biến động mạnh, sắp thanh lý, lỗ sâu, chưa có SL, lãi lớn chưa bảo vệ. Gửi thông báo đẩy và lưu ở đầu tab Danh mục."
      />
      {s.enabled && WidgetRefresher.available && !WidgetRefresher.isEnabled() && (
        <Text style={styles.warn}>
          Khi app đóng, nhắc nhở chạy nhờ widget: cần có widget PnL trên màn hình chính và bật "Tự cập nhật liên tục" ở mục Widget.
        </Text>
      )}

      <Text style={styles.label}>Biến động mạnh: giá đổi trong 5 phút ≥</Text>
      <View style={styles.row}>
        {MOVE_OPTIONS.map((m) => (
          <Chip key={m} label={`${m}%`} active={s.movePct === m} onPress={() => update({ movePct: m })} />
        ))}
      </View>
      <Text style={styles.label}>Lỗ sâu: ROE ≤</Text>
      <View style={styles.row}>
        {LOSS_OPTIONS.map((l) => (
          <Chip key={l} label={`−${l}%`} active={s.lossRoe === l} onPress={() => update({ lossRoe: l })} />
        ))}
      </View>

      <Text style={styles.label}>Gemini API key</Text>
      <View style={styles.row}>
        <TextInput
          value={key}
          onChangeText={setKey}
          placeholder="AIza…"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          style={styles.input}
        />
        <Pressable onPress={checkKey} style={styles.small} disabled={checking}>
          {checking ? <ActivityIndicator color={colors.text} /> : <Text style={styles.smallText}>Kiểm tra</Text>}
        </Pressable>
      </View>
      <Text style={styles.sub}>
        {savedKey ? 'Đã lưu key (mã hóa trong máy). ' : 'Lấy key tại aistudio.google.com. '}
        Khi có nhắc nhở, số liệu vị thế (cặp, giá, PnL, TP/SL) được gửi tới Google Gemini để viết gợi ý. Tối đa 40 lượt/ngày.
      </Text>
      {savedKey ? (
        <Pressable onPress={removeKey} hitSlop={6}>
          <Text style={[styles.sub, { color: colors.short, marginTop: 4 }]}>Xóa key</Text>
        </Pressable>
      ) : null}

      {savedKey ? (
        <>
          <Switch
            on={s.aiEnabled}
            onPress={() => update({ aiEnabled: !s.aiEnabled })}
            title="Dùng Gemini viết nhận định & gợi ý"
            sub="Tắt thì vẫn có cảnh báo theo quy tắc, không gửi dữ liệu ra ngoài."
          />
          {groups.length > 0 && (
            <>
              <Text style={styles.label}>Model Gemini</Text>
              <ModelSelect groups={groups} value={s.model} onChange={(model) => update({ model })} />
            </>
          )}
          {!models.length && <Text style={styles.sub}>Bấm Kiểm tra để tải danh sách model.</Text>}
          <Text style={styles.sub}>
            Bản "preview" mới nhưng hay quá tải. Khi model chính quá tải, app tự thử lại rồi chuyển sang model ổn định khác.
          </Text>
        </>
      ) : null}

      <Pressable onPress={test} disabled={testing} style={[styles.button, testing && { opacity: 0.6 }]}>
        {testing ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>Gửi nhắc nhở thử</Text>}
      </Pressable>
    </View>
  );
}

const FAMILIES: { family: ModelFamily; title: string; note: string }[] = [
  { family: 'flash', title: 'Flash', note: 'nhanh, hạn mức cao — hợp cho nhắc nhở' },
  { family: 'pro', title: 'Pro', note: 'phân tích kỹ hơn, chậm hơn, hạn mức miễn phí thấp' },
  { family: 'other', title: 'Khác', note: '' },
];

const modelLabel = (name: string) => name.replace('models/', '');

/** One field showing the chosen model; the full grouped list opens in a bottom sheet. */
function ModelSelect({
  groups,
  value,
  onChange,
}: {
  groups: { family: ModelFamily; title: string; note: string; list: GeminiModel[] }[];
  value: string;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = groups.flatMap((g) => g.list).find((m) => m.name === value);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.select}>
        <Text style={styles.selectText} numberOfLines={1}>
          {value ? `${modelLabel(value)}${current?.preview ? ' · preview' : ''}` : 'Chọn model'}
        </Text>
        <Text style={styles.selectCaret}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Chọn model Gemini</Text>
            <ScrollView>
              {groups.map((g) => (
                <View key={g.family}>
                  <Text style={styles.label}>
                    {g.title}
                    {g.note ? ` · ${g.note}` : ''}
                  </Text>
                  {g.list.map((m) => {
                    const active = m.name === value;
                    return (
                      <Pressable
                        key={m.name}
                        onPress={() => {
                          onChange(m.name);
                          setOpen(false);
                        }}
                        style={({ pressed }) => [styles.option, active && styles.optionActive, pressed && { opacity: 0.6 }]}
                      >
                        <Text style={[styles.optionText, active && { color: colors.warn }]} numberOfLines={1}>
                          {modelLabel(m.name)}
                          {m.preview ? ' · preview' : ''}
                        </Text>
                        {active && <Text style={{ color: colors.warn, fontWeight: '800' }}>✓</Text>}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

function Switch({ on, onPress, title, sub }: { on: boolean; onPress: () => void; title: string; sub: string }) {
  return (
    <Pressable onPress={onPress} style={styles.switchRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.switchTitle}>{title}</Text>
        <Text style={styles.sub}>{sub}</Text>
      </View>
      <View style={[styles.track, on && { backgroundColor: colors.long }]}>
        <View style={[styles.thumb, on && styles.thumbOn]} />
      </View>
    </Pressable>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = createStyles({
  section: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 28, marginBottom: 4 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  switchTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 3, lineHeight: 17 },
  warn: { color: colors.warn, fontSize: 12, marginTop: 8, lineHeight: 17 },
  track: { width: 46, height: 26, borderRadius: 13, backgroundColor: colors.cardAlt, padding: 3 },
  thumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.muted },
  thumbOn: { backgroundColor: colors.text, marginLeft: 20 },
  label: { color: colors.muted, fontSize: 13, marginTop: 14, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    justifyContent: 'center',
  },
  chipActive: { borderColor: colors.warn, backgroundColor: colors.warn + '1F' },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 48,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  selectText: { flex: 1, color: colors.text, fontSize: 15 },
  selectCaret: { color: colors.muted, fontSize: 16 },
  backdrop: { flex: 1, backgroundColor: '#000000AA' },
  sheet: {
    maxHeight: '75%',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    backgroundColor: colors.sheet,
  },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, paddingHorizontal: 10, borderRadius: 8 },
  optionActive: { backgroundColor: colors.warn + '1F' },
  optionText: { flex: 1, color: colors.text, fontSize: 15 },
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
  small: { height: 48, paddingHorizontal: 14, borderRadius: 8, backgroundColor: colors.cardAlt, justifyContent: 'center' },
  smallText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  button: {
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '700' },
});
