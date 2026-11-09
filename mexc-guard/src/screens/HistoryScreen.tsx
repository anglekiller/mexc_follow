import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Text, View } from 'react-native';

import type { ClosedPosition, ContractInfo } from '../api/types';
import { Header } from '../components/Header';
import { tap } from '../haptics';
import { errorMessage, type Futures } from '../hooks/useFutures';
import { createStyles, colors, fmt, fmtVol, pnlColor, signed } from '../theme';

const p2 = (n: number) => String(n).padStart(2, '0');
const monthStart = (y: number, m: number) => new Date(y, m, 1).getTime();
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
};
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
function duration(ms: number) {
  const min = Math.max(Math.round(ms / 60_000), 0);
  if (min < 60) return `${min}p`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}g${min % 60 ? `${p2(min % 60)}p` : ''}`;
  return `${Math.round(h / 24)} ngày`;
}

/** Price decimals: the contract's when known, otherwise from the price's magnitude. */
const dpOf = (c: ContractInfo | undefined, price: number) =>
  c?.priceScale ?? (price >= 1000 ? 1 : price >= 1 ? 3 : price >= 0.01 ? 5 : 8);

export function HistoryScreen({ f }: { f: Futures }) {
  const api = f.api;
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [rows, setRows] = useState<ClosedPosition[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contracts, setContracts] = useState<Record<string, ContractInfo>>({});
  const cache = useRef(new Map<string, ClosedPosition[]>());
  const supported = !!api?.getClosedPositions;

  const isCurrentMonth = ym.y === now.getFullYear() && ym.m === now.getMonth();
  const cacheKey = `${api?.id}|${ym.y}-${ym.m}`;

  const load = useCallback(
    async (force: boolean) => {
      if (!api?.getClosedPositions) return;
      const hit = cache.current.get(cacheKey);
      if (hit && !force) {
        setRows(hit);
        return;
      }
      setError(null);
      try {
        const list = await api.getClosedPositions(monthStart(ym.y, ym.m), monthStart(ym.y, ym.m + 1) - 1);
        cache.current.set(cacheKey, list);
        setRows(list);
        // Contracts give contract size (ROE) and price decimals; failures just leave them out.
        const symbols = [...new Set(list.map((r) => r.symbol))];
        const got = await Promise.allSettled(symbols.map((s) => f.ensureContract(s)));
        setContracts((old) => {
          const next = { ...old };
          got.forEach((g, i) => g.status === 'fulfilled' && (next[symbols[i]] = g.value));
          return next;
        });
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [api, cacheKey, ym, f.ensureContract],
  );

  useEffect(() => {
    setRows(null);
    setLoading(true);
    load(false).finally(() => setLoading(false));
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const shift = (d: number) => {
    tap();
    setYm(({ y, m }) => {
      const t = new Date(y, m + d, 1);
      return { y: t.getFullYear(), m: t.getMonth() };
    });
  };

  const stats = useMemo(() => {
    const list = rows ?? [];
    const wins = list.filter((r) => r.pnl > 0);
    const losses = list.filter((r) => r.pnl < 0);
    const sum = (xs: (number | undefined)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
    return {
      count: list.length,
      pnl: sum(list.map((r) => r.pnl)),
      wins: wins.length,
      losses: losses.length,
      winRate: list.length ? (wins.length / list.length) * 100 : 0,
      grossWin: sum(wins.map((r) => r.pnl)),
      grossLoss: sum(losses.map((r) => r.pnl)),
      best: list.reduce<ClosedPosition | null>((b, r) => (!b || r.pnl > b.pnl ? r : b), null),
      worst: list.reduce<ClosedPosition | null>((b, r) => (!b || r.pnl < b.pnl ? r : b), null),
      fee: list.some((r) => r.fee !== undefined) ? sum(list.map((r) => r.fee)) : undefined,
      funding: list.some((r) => r.funding !== undefined) ? sum(list.map((r) => r.funding)) : undefined,
    };
  }, [rows]);

  const sections = useMemo(() => {
    const byDay = new Map<string, ClosedPosition[]>();
    for (const r of rows ?? []) {
      const k = dayKey(r.closeTime);
      byDay.set(k, [...(byDay.get(k) ?? []), r]);
    }
    return [...byDay.entries()].map(([title, data]) => ({ title, data, pnl: data.reduce((s, r) => s + r.pnl, 0) }));
  }, [rows]);

  const name = (s: string) => (api ? api.baseOf(s) : s);
  const profitFactor = stats.grossLoss < 0 ? stats.grossWin / -stats.grossLoss : null;

  const summary = (
    <View>
      <View style={styles.monthRow}>
        <Pressable onPress={() => shift(-1)} hitSlop={12} style={styles.monthBtn}>
          <Text style={styles.monthArrow}>‹</Text>
        </Pressable>
        <Text style={styles.month}>
          Tháng {ym.m + 1}/{ym.y}
        </Text>
        <Pressable
          onPress={() => !isCurrentMonth && shift(1)}
          hitSlop={12}
          style={[styles.monthBtn, isCurrentMonth && { opacity: 0.25 }]}
        >
          <Text style={styles.monthArrow}>›</Text>
        </Pressable>
      </View>

      {rows && rows.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.muted}>Lãi/lỗ đã chốt (USDT)</Text>
          <Text style={[styles.total, { color: pnlColor(stats.pnl) }]}>{signed(stats.pnl, 2)}</Text>
          <View style={styles.grid}>
            <Stat label="Số lệnh" value={String(stats.count)} />
            <Stat
              label="Thắng / Thua"
              value={`${stats.wins} / ${stats.losses}`}
            />
            <Stat label="Tỷ lệ thắng" value={`${fmt(stats.winRate, 1)}%`} color={stats.winRate >= 50 ? colors.long : colors.short} />
          </View>
          <View style={styles.grid}>
            <Stat label="Tổng lãi" value={signed(stats.grossWin, 2)} color={colors.long} />
            <Stat label="Tổng lỗ" value={signed(stats.grossLoss, 2)} color={colors.short} />
            <Stat label="Hệ số lợi nhuận" value={profitFactor === null ? '—' : fmt(profitFactor, 2)} />
          </View>
          <View style={styles.grid}>
            <Stat
              label="Lệnh lãi nhất"
              value={stats.best && stats.best.pnl > 0 ? `${name(stats.best.symbol)} ${signed(stats.best.pnl, 2)}` : '—'}
              color={colors.long}
            />
            <Stat
              label="Lệnh lỗ nhất"
              value={stats.worst && stats.worst.pnl < 0 ? `${name(stats.worst.symbol)} ${signed(stats.worst.pnl, 2)}` : '—'}
              color={colors.short}
            />
          </View>
          {(stats.fee !== undefined || stats.funding !== undefined) && (
            <View style={styles.grid}>
              {stats.fee !== undefined && <Stat label="Phí giao dịch đã trả" value={`${fmt(stats.fee, 4)}`} />}
              {stats.funding !== undefined && (
                <Stat
                  label={stats.funding >= 0 ? 'Funding đã trả' : 'Funding nhận được'}
                  value={fmt(Math.abs(stats.funding), 4)}
                />
              )}
            </View>
          )}
          <Text style={[styles.muted, { marginTop: 8 }]}>Lãi/lỗ theo số sàn báo, đã trừ phí và funding.</Text>
        </View>
      )}
    </View>
  );

  if (!api) return null;

  return (
    <View style={styles.screen}>
      <Header title="Lịch sử" ws={f.wsStatus} />
      {!supported ? (
        <Text style={styles.empty}>
          {api.name} chưa hỗ trợ lịch sử lệnh trong app (sàn không có API lịch sử vị thế). Hiện chỉ có cho MEXC.
        </Text>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => `${r.id}-${r.closeTime}`}
          ListHeaderComponent={summary}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} />}
          renderSectionHeader={({ section }) => (
            <View style={styles.dayRow}>
              <Text style={styles.day}>{section.title}</Text>
              <Text style={[styles.dayPnl, { color: pnlColor(section.pnl) }]}>
                {signed(section.pnl, 2)} · {section.data.length} lệnh
              </Text>
            </View>
          )}
          renderItem={({ item: r }) => {
            const c = contracts[r.symbol];
            const dp = dpOf(c, r.entryPrice);
            const margin = c && r.leverage > 0 ? (r.vol * c.contractSize * r.entryPrice) / r.leverage : 0;
            const roe = margin > 0 ? (r.pnl / margin) * 100 : undefined;
            const move = r.entryPrice > 0 ? ((r.closePrice - r.entryPrice) / r.entryPrice) * 100 : 0;
            return (
              <View style={[styles.row, { borderLeftColor: r.long ? colors.long : colors.short }]}>
                <View style={styles.rowTop}>
                  <Text style={styles.symbol}>{name(r.symbol)}</Text>
                  <Text style={[styles.side, { color: r.long ? colors.long : colors.short }]}>
                    {r.long ? 'Long' : 'Short'} {r.leverage}x
                  </Text>
                  <Text style={styles.muted}> · {fmtVol(r.vol, c)}</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={[styles.pnl, { color: pnlColor(r.pnl) }]}>{signed(r.pnl, 2)}</Text>
                </View>
                <View style={styles.rowMid}>
                  <Text style={styles.prices}>
                    <Text style={styles.muted}>Vào </Text>
                    {fmt(r.entryPrice, dp)}
                    <Text style={styles.muted}>  →  Đóng </Text>
                    {fmt(r.closePrice, dp)}
                    <Text style={{ color: pnlColor(move * (r.long ? 1 : -1)) }}> ({signed(move, 2)}%)</Text>
                  </Text>
                  <View style={{ flex: 1 }} />
                  {roe !== undefined && (
                    <Text style={[styles.roe, { color: pnlColor(roe) }]}>ROE {signed(roe, 1)}%</Text>
                  )}
                </View>
                <Text style={styles.meta}>
                  {r.openTime ? `${dayKey(r.openTime)} ${hm(r.openTime)} → ` : ''}
                  {hm(r.closeTime)}
                  {r.openTime ? ` · giữ ${duration(r.closeTime - r.openTime)}` : ''}
                  {r.fee !== undefined ? ` · phí ${fmt(r.fee, 4)}` : ''}
                  {r.funding ? ` · funding ${signed(-r.funding, 4)}` : ''}
                </Text>
              </View>
            );
          }}
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator color={colors.muted} style={{ marginTop: 40 }} />
            ) : error ? (
              <Text style={[styles.empty, { color: colors.short }]}>{error}</Text>
            ) : (
              <Text style={styles.empty}>Không có lệnh nào đóng trong tháng này.</Text>
            )
          }
        />
      )}
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = createStyles({
  screen: { flex: 1, backgroundColor: colors.page },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  muted: { color: colors.muted, fontSize: 12 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginVertical: 8, gap: 16 },
  monthBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  monthArrow: { color: colors.text, fontSize: 24, fontWeight: '600', marginTop: -3 },
  month: { color: colors.text, fontSize: 17, fontWeight: '700', minWidth: 130, textAlign: 'center' },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 6 },
  total: { fontSize: 28, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', marginTop: 12, gap: 8 },
  statValue: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  dayRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 6 },
  day: { color: colors.text, fontSize: 14, fontWeight: '700' },
  dayPnl: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  row: {
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
    borderLeftWidth: 3,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  symbol: { color: colors.text, fontSize: 15, fontWeight: '700' },
  side: { fontSize: 12, fontWeight: '700', marginLeft: 6 },
  pnl: { fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rowMid: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  prices: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  roe: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  meta: { color: colors.muted, fontSize: 11, marginTop: 4 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40, paddingHorizontal: 24, lineHeight: 20 },
});
