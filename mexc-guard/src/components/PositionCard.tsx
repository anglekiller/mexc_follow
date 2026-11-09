import { memo } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { PositionView } from '../hooks/useFutures';
import { createStyles, colors, fmt, fmtVol, pairLabel, pnlColor, signed, useGlass } from '../theme';

interface Props {
  p: PositionView;
  busy: boolean;
  onClose: (p: PositionView, fraction: number) => void;
  /** Current take-profit / stop-loss prices, if any. */
  tp?: number;
  sl?: number;
  onEditTpSl: (p: PositionView) => void;
}

function Cell({ label, value, color, align }: { label: string; value: string; color?: string; align?: 'right' }) {
  return (
    <View style={[styles.cell, align === 'right' && { alignItems: 'flex-end' }]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export const PositionCard = memo(function PositionCard({ p, busy, onClose, tp, sl, onEditTpSl }: Props) {
  useGlass();
  const isLong = p.positionType === 1;
  const sideColor = isLong ? colors.long : colors.short;
  const dp = p.contract?.priceScale ?? 4;
  const coinSize = p.contract ? p.holdVol * p.contract.contractSize : undefined;
  const base = p.contract?.baseCoin ?? p.symbol.split(/[_-]/)[0];
  const pnl = p.pnl ?? 0;

  return (
    <View style={[styles.card, { borderLeftColor: sideColor }]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={styles.symbol}>{pairLabel(p.symbol)}</Text>
            <Text style={[styles.tag, { color: sideColor, backgroundColor: sideColor + '1F' }]}>
              {isLong ? 'Long' : 'Short'} {p.leverage}x
            </Text>
            <Text style={styles.tagMuted}>{p.openType === 1 ? 'Isolated' : 'Cross'}</Text>
          </View>
          <Text style={styles.sub}>
            {fmtVol(p.holdVol, p.contract)}
            {coinSize !== undefined && p.contract?.contractSize !== 1 ? ` · ${fmt(coinSize, 4)} ${base}` : ''}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.pnl, { color: pnlColor(pnl) }]}>{p.pnl === undefined ? '—' : signed(pnl, 2)}</Text>
          <Text style={[styles.roe, { color: pnlColor(p.roe ?? 0) }]}>
            {p.roe === undefined ? 'ROE —' : `ROE ${signed(p.roe)}%`}
          </Text>
        </View>
      </View>

      <View style={styles.grid}>
        <Cell label="Giá vào" value={fmt(p.holdAvgPrice, dp)} />
        <Cell label="Giá đánh dấu" value={fmt(p.mark, dp)} />
        <Cell label="Thanh lý" value={fmt(p.liquidatePrice, dp)} color={colors.warn} align="right" />
      </View>
      <View style={styles.grid}>
        <Cell label="Margin" value={fmt(p.im, 2)} />
        <Cell label="Đang khóa" value={fmtVol(p.frozenVol, p.contract)} />
        <Cell label="Đã chốt" value={signed(p.realised ?? 0, 2)} color={pnlColor(p.realised ?? 0)} align="right" />
      </View>

      <Pressable onPress={() => onEditTpSl(p)} style={({ pressed }) => [styles.tpslRow, pressed && styles.dim]}>
        {tp === undefined && sl === undefined ? (
          <Text style={[styles.tpslText, { color: colors.warn }]}>⚠ Chưa đặt TP/SL — chạm để đặt</Text>
        ) : (
          <Text style={styles.tpslText}>
            <Text style={{ color: colors.long }}>TP {tp !== undefined ? fmt(tp, dp) : '—'}</Text>
            <Text style={{ color: colors.muted }}>   ·   </Text>
            <Text style={{ color: colors.short }}>SL {sl !== undefined ? fmt(sl, dp) : '—'}</Text>
          </Text>
        )}
        <Text style={styles.tpslEdit}>Sửa ›</Text>
      </Pressable>

      <View style={styles.actions}>
        {[0.25, 0.5].map((f) => (
          <Pressable
            key={f}
            onPress={() => onClose(p, f)}
            disabled={busy}
            style={({ pressed }) => [styles.partial, (pressed || busy) && styles.dim]}
          >
            <Text style={styles.partialText}>{f * 100}%</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => onClose(p, 1)}
          disabled={busy}
          style={({ pressed }) => [styles.closeBtn, (pressed || busy) && styles.dim]}
        >
          {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.closeText}>Đóng Market</Text>}
        </Pressable>
      </View>
    </View>
  );
});

const styles = createStyles({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  symbol: { color: colors.text, fontSize: 16, fontWeight: '700' },
  tag: { fontSize: 11, fontWeight: '700', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden' },
  tagMuted: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 3 },
  pnl: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  roe: { fontSize: 12, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', marginTop: 10 },
  cell: { flex: 1 },
  label: { color: colors.muted, fontSize: 11 },
  value: { color: colors.text, fontSize: 13, marginTop: 2, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  tpslRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingHorizontal: 10,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
  },
  tpslText: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tpslEdit: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  partial: {
    width: 64,
    height: 42,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  partialText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  closeBtn: {
    flex: 1,
    height: 42,
    borderRadius: 8,
    backgroundColor: colors.short,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dim: { opacity: 0.5 },
});
