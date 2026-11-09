import { memo } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { SIDE_LABEL, type ContractInfo, type PendingOrder } from '../api/types';
import { createStyles, colors, fmt, fmtTime, fmtVol, pairLabel, useGlass } from '../theme';

interface Props {
  o: PendingOrder;
  /** Contract of the order's symbol, when known (price precision, volume unit). */
  contract?: ContractInfo;
  busy: boolean;
  onCancel: (o: PendingOrder) => void;
}

// Sides 1/2 buy (open long / close short), 3/4 sell (open short / close long).
const sideColor = (side?: number) =>
  side === 1 || side === 2 ? colors.long : side === 3 || side === 4 ? colors.short : colors.muted;

export const OrderRow = memo(function OrderRow({ o, contract, busy, onCancel }: Props) {
  useGlass();
  const priceScale = contract?.priceScale;
  const num = (n?: number) =>
    n === undefined ? '—' : fmt(n, priceScale ?? (n < 1 ? 6 : n < 100 ? 4 : 2));

  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <View style={styles.header}>
          <Text style={styles.symbol}>{pairLabel(o.symbol)}</Text>
          <Text style={styles.type}>{o.typeLabel}</Text>
          {o.side !== undefined && (
            <Text style={[styles.side, { color: sideColor(o.side) }]}>{SIDE_LABEL[o.side] ?? `Side ${o.side}`}</Text>
          )}
        </View>

        {o.kind === 'tpsl' ? (
          <Text style={styles.line}>
            TP <Text style={{ color: colors.long }}>{num(o.takeProfitPrice)}</Text>
            {'   '}SL <Text style={{ color: colors.short }}>{num(o.stopLossPrice)}</Text>
          </Text>
        ) : (
          <Text style={styles.line}>
            {o.triggerPrice !== undefined && `Kích hoạt ${num(o.triggerPrice)} · `}
            Giá {o.price === undefined ? 'Market' : num(o.price)}
          </Text>
        )}

        <Text style={styles.meta}>
          {o.vol !== undefined && `Khớp ${fmt(o.dealVol ?? 0, contract?.volScale ?? 0)}/${fmtVol(o.vol, contract)} · `}
          {fmtTime(o.createTime)}
        </Text>
      </View>

      <Pressable
        onPress={() => onCancel(o)}
        disabled={busy}
        hitSlop={8}
        style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.6 }, busy && { opacity: 0.4 }]}
      >
        {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.cancelText}>Hủy</Text>}
      </Pressable>
    </View>
  );
});

const styles = createStyles({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  symbol: { color: colors.text, fontSize: 15, fontWeight: '700' },
  type: { color: colors.muted, fontSize: 12 },
  side: { fontSize: 12, fontWeight: '700' },
  line: { color: colors.text, fontSize: 14, marginTop: 4, fontVariant: ['tabular-nums'] },
  meta: { color: colors.muted, fontSize: 12, marginTop: 3 },
  cancelBtn: {
    marginLeft: 10,
    width: 72,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { color: colors.text, fontSize: 14, fontWeight: '600' },
});
