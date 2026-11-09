import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, Text, TextInput, View } from 'react-native';

import type { PositionView } from '../hooks/useFutures';
import { tap } from '../haptics';
import { createStyles, colors, fmt, pairLabel, pnlColor, signed } from '../theme';

const TP_ROE = [25, 50, 100, 200];
const SL_ROE = [10, 25, 50];

interface Props {
  /** Position being edited; null hides the sheet. */
  p: PositionView | null;
  currentTp?: number;
  currentSl?: number;
  onSave: (tp: number | null, sl: number | null) => Promise<void>;
  onClose: () => void;
}

const num = (s: string) => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Edit the take-profit / stop-loss of one open position. */
export function TpSlSheet({ p, currentTp, currentSl, onSave, onClose }: Props) {
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = p?.positionId;
  useEffect(() => {
    if (!p) return;
    const dp0 = p.contract?.priceScale ?? 4;
    setTp(currentTp ? currentTp.toFixed(dp0) : '');
    setSl(currentSl ? currentSl.toFixed(dp0) : '');
    setError(null);
    setSaving(false);
    // Only when a different position is opened, not on every price tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!p) return null;

  const isLong = p.positionType === 1;
  const dir = isLong ? 1 : -1;
  const c = p.contract;
  const dp = c?.priceScale ?? 4;
  const entry = p.holdAvgPrice;
  const mark = p.mark ?? entry;
  const qty = c ? p.holdVol * c.contractSize : 0;
  const taker = c?.takerFeeRate ?? 0;
  const margin = p.im || (qty * entry) / p.leverage;

  const round = (v: number) => {
    const unit = c?.priceUnit || Math.pow(10, -dp);
    return (Math.round(v / unit) * unit).toFixed(dp);
  };
  /** Price at which the position shows `roe` percent (sign included). */
  const priceAtRoe = (roe: number) => round(entry * (1 + (dir * roe) / 100 / p.leverage));

  const tpN = num(tp);
  const slN = num(sl);
  // PnL if the order fills at its trigger, after the taker fee of the closing market order.
  const pnlAt = (price: number) => qty * (price - entry) * dir - qty * price * taker;
  const roeOf = (pnl: number) => (margin > 0 ? (pnl / margin) * 100 : 0);

  const tpBad = tpN !== null && (isLong ? tpN <= mark : tpN >= mark);
  const slBad = slN !== null && (isLong ? slN >= mark : slN <= mark);
  const slAfterLiq = slN !== null && p.liquidatePrice > 0 && (isLong ? slN <= p.liquidatePrice : slN >= p.liquidatePrice);
  const unchanged = (tpN ?? undefined) === currentTp && (slN ?? undefined) === currentSl;
  const canSave = !saving && !tpBad && !slBad && !unchanged;

  const save = async (nextTp: number | null, nextSl: number | null) => {
    tap();
    setSaving(true);
    setError(null);
    try {
      await onSave(nextTp, nextSl);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const Preview = ({ price }: { price: number | null }) => {
    if (price === null) return <Text style={styles.preview}>Không đặt</Text>;
    const pnl = pnlAt(price);
    return (
      <Text style={[styles.preview, { color: pnlColor(pnl) }]}>
        {signed(pnl, 2)} USDT · ROE {signed(roeOf(pnl), 1)}% · {signed(((price - entry) / entry) * 100, 2)}% giá
      </Text>
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView behavior="padding">
        <View style={styles.sheet}>
          <Text style={styles.title}>
            TP/SL · {pairLabel(p.symbol)}{' '}
            <Text style={{ color: isLong ? colors.long : colors.short }}>
              {isLong ? 'Long' : 'Short'} {p.leverage}x
            </Text>
          </Text>
          <Text style={styles.muted}>
            Giá vào {fmt(entry, dp)} · Đánh dấu {fmt(mark, dp)} · Thanh lý {fmt(p.liquidatePrice, dp)}
          </Text>

          {/* Take profit */}
          <Text style={[styles.label, { color: colors.long }]}>Chốt lời (TP)</Text>
          <TextInput
            value={tp}
            onChangeText={(t) => setTp(t.replace(',', '.'))}
            keyboardType="decimal-pad"
            placeholder={isLong ? `> ${fmt(mark, dp)}` : `< ${fmt(mark, dp)}`}
            placeholderTextColor={colors.muted}
            style={[styles.input, tpBad && styles.inputBad]}
          />
          <View style={styles.chips}>
            {TP_ROE.map((r) => (
              <Chip key={r} label={`+${r}%`} onPress={() => setTp(priceAtRoe(r))} />
            ))}
            {tp !== '' && <Chip label="Bỏ" onPress={() => setTp('')} />}
          </View>
          {tpBad ? (
            <Text style={styles.bad}>TP phải {isLong ? 'cao hơn' : 'thấp hơn'} giá đánh dấu.</Text>
          ) : (
            <Preview price={tpN} />
          )}

          {/* Stop loss */}
          <Text style={[styles.label, { color: colors.short }]}>Cắt lỗ (SL)</Text>
          <TextInput
            value={sl}
            onChangeText={(t) => setSl(t.replace(',', '.'))}
            keyboardType="decimal-pad"
            placeholder={isLong ? `< ${fmt(mark, dp)}` : `> ${fmt(mark, dp)}`}
            placeholderTextColor={colors.muted}
            style={[styles.input, slBad && styles.inputBad]}
          />
          <View style={styles.chips}>
            <Chip label="Hòa vốn" onPress={() => setSl(round(entry))} />
            {SL_ROE.map((r) => (
              <Chip key={r} label={`−${r}%`} onPress={() => setSl(priceAtRoe(-r))} />
            ))}
            {sl !== '' && <Chip label="Bỏ" onPress={() => setSl('')} />}
          </View>
          {slBad ? (
            <Text style={styles.bad}>SL phải {isLong ? 'thấp hơn' : 'cao hơn'} giá đánh dấu.</Text>
          ) : (
            <Preview price={slN} />
          )}
          {slAfterLiq && !slBad && (
            <Text style={styles.bad}>⚠ SL nằm sau giá thanh lý — vị thế sẽ bị thanh lý trước khi chạm SL.</Text>
          )}

          <Text style={[styles.muted, { marginTop: 10 }]}>
            Nút % là ROE theo đòn bẩy {p.leverage}x. Khi khớp sẽ đóng Market toàn bộ vị thế; lãi/lỗ đã trừ phí Taker.
          </Text>
          {error && <Text style={styles.bad}>{error}</Text>}

          <View style={styles.actions}>
            {(currentTp !== undefined || currentSl !== undefined) && (
              <Pressable
                onPress={() => save(null, null)}
                disabled={saving}
                style={({ pressed }) => [styles.secondary, (pressed || saving) && { opacity: 0.5 }]}
              >
                <Text style={styles.secondaryText}>Xóa TP/SL</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => save(tpN, slN)}
              disabled={!canSave}
              style={({ pressed }) => [styles.primary, (!canSave || pressed) && { opacity: 0.45 }]}
            >
              {saving ? <ActivityIndicator color={colors.bg} /> : <Text style={styles.primaryText}>Lưu</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.chip, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const styles = createStyles({
  backdrop: { flex: 1, backgroundColor: '#000000AA' },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 12, marginTop: 4 },
  label: { fontSize: 13, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  input: {
    height: 46,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 17,
    fontVariant: ['tabular-nums'],
  },
  inputBad: { borderColor: colors.short },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: {
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  preview: { color: colors.muted, fontSize: 12, marginTop: 6, fontVariant: ['tabular-nums'] },
  bad: { color: colors.short, fontSize: 12, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  secondary: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.short,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: colors.short, fontSize: 15, fontWeight: '700' },
  primary: { flex: 2, height: 48, borderRadius: 10, backgroundColor: colors.warn, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: colors.bg, fontSize: 16, fontWeight: '800' },
});
