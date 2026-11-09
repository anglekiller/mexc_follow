import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { feeBadge, isZeroFee } from '../api/fees';
import type { Exchange, FeeRates } from '../exchanges';
import type { Ticker } from '../api/types';
import { colors, createStyles, fmt, pnlColor, signed } from '../theme';

interface Props {
  api: Exchange | null;
  visible: boolean;
  current: string;
  /** Symbols to pin on top (held positions). */
  pinned: string[];
  onSelect: (symbol: string) => void;
  onClose: () => void;
}

type FeeFilter = 'all' | 'zero' | 'paid';
const FEE_FILTERS: { value: FeeFilter; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'zero', label: '0 phí' },
  { value: 'paid', label: 'Có phí' },
];

const priceDp = (p: number) => (p >= 1000 ? 1 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8);

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toFixed(0);

/** Full-screen searchable list of USDT perpetual pairs, sorted by 24h turnover. */
export function SymbolPicker({ api, visible, current, pinned, onSelect, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [fees, setFees] = useState<Record<string, FeeRates> | null>(null);
  const [feeFilter, setFeeFilter] = useState<FeeFilter>('all');

  useEffect(() => {
    if (!visible || !api) return;
    setQuery('');
    setLoading(true);
    api
      .getTickers()
      .then((t) => setTickers([...t].sort((a, b) => b.amount24 - a.amount24)))
      .catch(() => {})
      .finally(() => setLoading(false));
    api
      .getFeeRates?.()
      .then(setFees)
      .catch(() => setFees(null));
  }, [visible, api]);

  const data = useMemo(() => {
    const q = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    let list = q ? tickers.filter((t) => t.symbol.replace(/[^A-Z0-9]/g, '').includes(q) || api?.baseOf(t.symbol).includes(q)) : tickers;
    if (fees && feeFilter !== 'all') list = list.filter((t) => fees[t.symbol] && isZeroFee(fees[t.symbol]) === (feeFilter === 'zero'));
    if (q) return list;
    const pin = new Set(pinned);
    return [...list.filter((t) => pin.has(t.symbol)), ...list.filter((t) => !pin.has(t.symbol))];
  }, [tickers, query, pinned, api, fees, feeFilter]);
  const zeroCount = useMemo(() => (fees ? tickers.filter((t) => isZeroFee(fees[t.symbol])).length : 0), [fees, tickers]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.searchRow}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Tìm cặp, ví dụ BTC, PEPE…"
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            style={styles.search}
          />
          <Pressable onPress={onClose} hitSlop={10} style={styles.cancel}>
            <Text style={styles.cancelText}>Đóng</Text>
          </Pressable>
        </View>

        {fees && (
          <View style={styles.filters}>
            {FEE_FILTERS.map((f) => (
              <Pressable
                key={f.value}
                onPress={() => setFeeFilter(f.value)}
                style={[styles.filter, feeFilter === f.value && styles.filterActive]}
              >
                <Text style={[styles.filterText, feeFilter === f.value && { color: colors.text }]}>
                  {f.label}
                  {f.value === 'zero' && zeroCount > 0 ? ` (${zeroCount})` : ''}
                </Text>
              </Pressable>
            ))}
            <Text style={styles.feeNote}>Phí Taker</Text>
          </View>
        )}

        <View style={styles.headRow}>
          <Text style={[styles.head, { flex: 1 }]}>Cặp · KL 24h</Text>
          <Text style={[styles.head, styles.colPrice]}>Giá</Text>
          <Text style={[styles.head, styles.colChange]}>24h</Text>
        </View>

        {loading && tickers.length === 0 ? (
          <ActivityIndicator color={colors.muted} style={{ marginTop: 40 }} />
        ) : (
          <FlatList
            data={data}
            keyExtractor={(t) => t.symbol}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={20}
            renderItem={({ item }) => {
              const active = item.symbol === current;
              return (
                <Pressable
                  onPress={() => onSelect(item.symbol)}
                  style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && { opacity: 0.6 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.symbol}>
                      {api ? api.baseOf(item.symbol) : item.symbol}
                      <Text style={styles.quote}>/USDT</Text>
                      {pinned.includes(item.symbol) && <Text style={styles.held}>  • đang giữ</Text>}
                    </Text>
                    <View style={styles.subRow}>
                    <Text style={styles.vol}>{compact(item.amount24)} USDT</Text>
                    {fees?.[item.symbol] && (
                      <Text style={[styles.fee, isZeroFee(fees[item.symbol]) && styles.feeZero]}>
                        {feeBadge(fees[item.symbol])}
                      </Text>
                    )}
                    </View>
                  </View>
                  <Text style={[styles.price, styles.colPrice]}>{fmt(item.lastPrice, priceDp(item.lastPrice))}</Text>
                  <View style={[styles.colChange, styles.changeBox, { backgroundColor: pnlColor(item.riseFallRate) + '26' }]}>
                    <Text style={[styles.change, { color: pnlColor(item.riseFallRate) }]}>
                      {signed(item.riseFallRate * 100)}%
                    </Text>
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={<Text style={styles.empty}>Không tìm thấy cặp nào</Text>}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = createStyles({
  screen: { flex: 1, backgroundColor: colors.bg },
  searchRow: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  search: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 16,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 15,
  },
  cancel: { paddingHorizontal: 4 },
  cancelText: { color: colors.warn, fontSize: 15, fontWeight: '600' },
  headRow: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 6 },
  head: { color: colors.muted, fontSize: 11 },
  colPrice: { width: 110, textAlign: 'right' },
  colChange: { width: 78, marginLeft: 10, alignItems: 'flex-end', textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 56 },
  rowActive: { backgroundColor: colors.card },
  symbol: { color: colors.text, fontSize: 15, fontWeight: '700' },
  quote: { color: colors.muted, fontSize: 12, fontWeight: '400' },
  held: { color: colors.warn, fontSize: 11, fontWeight: '600' },
  vol: { color: colors.muted, fontSize: 11 },
  price: { color: colors.text, fontSize: 14, fontVariant: ['tabular-nums'] },
  changeBox: { height: 28, borderRadius: 6, justifyContent: 'center', paddingHorizontal: 6 },
  change: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 10 },
  filter: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  filterActive: { borderColor: colors.warn, backgroundColor: colors.warn + '1F' },
  filterText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  feeNote: { flex: 1, textAlign: 'right', color: colors.muted, fontSize: 11 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  fee: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 5,
    borderRadius: 4,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  feeZero: { color: colors.long, backgroundColor: colors.long + '26' },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40 },
});
