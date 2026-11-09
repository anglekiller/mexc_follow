import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';

import type { PendingOrder } from '../api/types';
import { Header } from '../components/Header';
import { OrderRow } from '../components/OrderRow';
import { tpslOf } from '../api/tpsl';
import type { Alerts } from '../alerts/useAlerts';
import { AlertsPanel } from '../components/AlertsPanel';
import { PositionCard } from '../components/PositionCard';
import { SlidingSelector } from '../components/SlidingSelector';
import { TpSlSheet } from '../components/TpSlSheet';
import { failure, heavy, success } from '../haptics';
import { errorMessage, floorToUnit, type Futures, type PositionView } from '../hooks/useFutures';
import { daysLeft, KEY_WARN_DAYS, type Credentials } from '../storage/credentials';
import { createStyles, colors, fmt, fmtTime, fmtVol, pairLabel, pnlColor, signed } from '../theme';

type Tab = 'positions' | 'orders';
const PORTFOLIO_TABS: Tab[] = ['positions', 'orders'];

interface Props {
  f: Futures;
  alerts: Alerts;
  creds: Credentials;
  onOpenSettings: () => void;
}

export function PortfolioScreen({ f, alerts, creds, onOpenSettings }: Props) {
  const [tab, setTab] = useState<Tab>('positions');
  // Keys of rows with an action in flight ("pos:<id>", "ord:<key>", "all").
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Position whose TP/SL sheet is open; looked up live so mark / PnL keep updating.
  const [tpslFor, setTpslFor] = useState<string | null>(null);
  const editing = tpslFor ? (f.positions.find((p) => p.positionId === tpslFor) ?? null) : null;
  const editingTpSl = editing ? tpslOf(editing, f.orders) : null;
  const onEditTpSl = useCallback((p: PositionView) => setTpslFor(p.positionId), []);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy((s) => new Set(s).add(key));
    try {
      await action();
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }, []);

  const report = (title: string, errors: string[]) => {
    (errors.length ? failure : success)();
    Alert.alert(errors.length ? `${title}: có lỗi` : `${title}: xong`, errors.join('\n') || undefined);
  };

  const onClosePosition = useCallback(
    (p: PositionView, fraction: number) => {
      heavy();
      const c = p.contract;
      const vol = fraction < 1 && c ? Math.max(floorToUnit(p.holdVol * fraction, c.volUnit, c.volScale), c.minVol) : p.holdVol;
      Alert.alert(
        `Đóng ${fraction * 100}% ${pairLabel(p.symbol)} ${p.positionType === 1 ? 'Long' : 'Short'}?`,
        `Lệnh Market đóng ${fmt(Math.min(vol, p.holdVol), c?.volScale ?? 0)}/${fmtVol(p.holdVol, c)}.` +
          (p.frozenVol > 0 && vol > p.holdVol - p.frozenVol ? '\nCác lệnh chờ của cặp này sẽ bị hủy trước.' : ''),
        [
          { text: 'Không', style: 'cancel' },
          {
            text: 'Đóng ngay',
            style: 'destructive',
            onPress: () =>
              run(`pos:${p.positionId}`, () =>
                f
                  .closePosition(p, fraction)
                  .then(success)
                  .catch((e) => {
                    failure();
                    Alert.alert('Đóng vị thế thất bại', errorMessage(e));
                  }),
              ),
          },
        ],
      );
    },
    [f.closePosition, run],
  );

  const onCancelOrder = useCallback(
    (o: PendingOrder) =>
      run(`ord:${o.key}`, () =>
        f
          .cancelOrder(o)
          .then(success)
          .catch((e) => {
            failure();
            Alert.alert('Hủy lệnh thất bại', errorMessage(e));
          }),
      ),
    [f.cancelOrder, run],
  );

  const onCancelAll = () => {
    heavy();
    Alert.alert('Hủy TẤT CẢ lệnh chờ?', `${f.orders.length} lệnh (Limit, Trigger, TP/SL).`, [
      { text: 'Không', style: 'cancel' },
      {
        text: 'Hủy tất cả',
        style: 'destructive',
        onPress: () => run('all', async () => report('Hủy tất cả lệnh', await f.cancelAll())),
      },
    ]);
  };

  const onCloseAll = () => {
    heavy();
    Alert.alert('ĐÓNG TẤT CẢ VỊ THẾ?', `Hủy toàn bộ lệnh chờ rồi đóng ${f.positions.length} vị thế bằng lệnh Market.`, [
      { text: 'Không', style: 'cancel' },
      {
        text: 'ĐÓNG TẤT CẢ',
        style: 'destructive',
        onPress: () => run('all', async () => report('Đóng tất cả', await f.closeAll())),
      },
    ]);
  };

  const left = daysLeft(creds);
  const panicBusy = busy.has('all');
  const refreshControl = (
    <RefreshControl
      refreshing={f.refreshing}
      onRefresh={f.pullToRefresh}
      tintColor={colors.text}
      colors={[colors.accent]}
      progressBackgroundColor={colors.card}
    />
  );

  return (
    <View style={styles.screen}>
      <Header
        title="Danh mục"
        ws={f.wsStatus}
        right={<Text style={styles.updated}>{f.lastUpdate ? fmtTime(f.lastUpdate).slice(0, 8) : ''}</Text>}
      />

      {left <= KEY_WARN_DAYS && (
        <Pressable onPress={onOpenSettings} style={[styles.banner, { backgroundColor: colors.warn + '22' }]}>
          <Text style={{ color: colors.warn, fontSize: 13 }}>
            {left > 0 ? `API Key hết hạn sau ${left} ngày.` : 'API Key có thể đã hết hạn.'} Chạm để cập nhật.
          </Text>
        </Pressable>
      )}
      {f.error && (
        <View style={[styles.banner, { backgroundColor: colors.short + '22' }]}>
          <Text style={{ color: colors.short, fontSize: 13 }} numberOfLines={2}>
            ⚠ {f.error}
          </Text>
        </View>
      )}

      <View style={styles.summary}>
        <View style={{ flex: 1 }}>
          <Text style={styles.muted}>Equity (USDT)</Text>
          <Text style={styles.big}>{fmt(f.asset?.equity)}</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          <Text style={styles.muted}>PnL chưa thực hiện</Text>
          <Text style={[styles.big, { color: pnlColor(f.unrealized) }]}>{signed(f.unrealized)}</Text>
        </View>
      </View>
      <View style={styles.summaryRow}>
        <Text style={styles.muted}>
          Khả dụng <Text style={styles.strong}>{fmt(f.asset?.availableBalance)}</Text>
        </Text>
        <Text style={styles.muted}>
          Margin <Text style={styles.strong}>{fmt(f.asset?.positionMargin)}</Text>
        </Text>
      </View>

      <View style={styles.tabs}>
        <SlidingSelector
          options={PORTFOLIO_TABS}
          value={tab}
          onChange={setTab}
          itemStyle={styles.tab}
          pillStyle={styles.tabActive}
          gloss={false}
          renderItem={(t, active) => (
            <Text style={[styles.tabText, active && styles.tabTextActive]}>
              {t === 'positions' ? `Vị thế (${f.positions.length})` : `Lệnh chờ (${f.orders.length})`}
            </Text>
          )}
        />
      </View>

      {tab === 'positions' ? (
        <FlatList
          data={f.positions}
          keyExtractor={(p) => p.positionId}
          ListHeaderComponent={<AlertsPanel alerts={alerts} />}
          renderItem={({ item }) => {
              const t = tpslOf(item, f.orders);
              return (
                <PositionCard
                  p={item}
                  busy={busy.has(`pos:${item.positionId}`) || panicBusy}
                  onClose={onClosePosition}
                  tp={t.tp}
                  sl={t.sl}
                  onEditTpSl={onEditTpSl}
                />
              );
          }}
          contentContainerStyle={styles.list}
          refreshControl={refreshControl}
          ListEmptyComponent={<Empty text={f.lastUpdate ? 'Không có vị thế đang mở' : 'Đang tải…'} />}
        />
      ) : (
        <FlatList
          data={f.orders}
          keyExtractor={(o) => o.key}
          renderItem={({ item }) => (
            <OrderRow
              o={item}
              contract={f.contracts[item.symbol]}
              busy={busy.has(`ord:${item.key}`) || panicBusy}
              onCancel={onCancelOrder}
            />
          )}
          contentContainerStyle={styles.list}
          refreshControl={refreshControl}
          ListEmptyComponent={<Empty text={f.lastUpdate ? 'Không có lệnh chờ' : 'Đang tải…'} />}
        />
      )}

      {/* Panic buttons, in thumb reach */}
      <View style={styles.panicRow}>
        <Pressable
          onPress={onCancelAll}
          disabled={panicBusy}
          style={({ pressed }) => [styles.panic, styles.panicSecondary, (pressed || panicBusy) && { opacity: 0.6 }]}
        >
          <Text style={styles.panicText}>Hủy tất cả lệnh</Text>
        </Pressable>
        <Pressable
          onPress={onCloseAll}
          disabled={panicBusy}
          style={({ pressed }) => [styles.panic, styles.panicPrimary, (pressed || panicBusy) && { opacity: 0.6 }]}
        >
          {panicBusy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.panicText}>ĐÓNG TẤT CẢ</Text>}
        </Pressable>
      </View>

      <TpSlSheet
        p={editing}
        currentTp={editingTpSl?.tp}
        currentSl={editingTpSl?.sl}
        onSave={async (tp, sl) => {
          if (!editing) return;
          try {
            await f.setTpSl(editing, tp, sl);
            success();
          } catch (e) {
            failure();
            throw new Error(errorMessage(e));
          }
        }}
        onClose={() => setTpslFor(null)}
      />
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return <Text style={[styles.muted, { textAlign: 'center', marginTop: 40, fontSize: 14 }]}>{text}</Text>;
}

const styles = createStyles({
  screen: { flex: 1, backgroundColor: colors.page },
  updated: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  muted: { color: colors.muted, fontSize: 12 },
  strong: { color: colors.text, fontWeight: '600' },
  big: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  banner: { marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 8 },
  summary: {
    flexDirection: 'row',
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    backgroundColor: colors.card,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    backgroundColor: colors.card,
  },
  tabs: { flexDirection: 'row', marginHorizontal: 16, marginTop: 10, borderBottomWidth: 1, borderColor: colors.border },
  tab: { alignItems: 'center', paddingVertical: 11 },
  tabActive: { borderBottomWidth: 2, borderColor: colors.warn },
  tabText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  tabTextActive: { color: colors.text },
  list: { padding: 16, paddingBottom: 16, flexGrow: 1 },
  panicRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  panic: { flex: 1, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  panicSecondary: { backgroundColor: colors.cardAlt, borderWidth: 1, borderColor: colors.muted },
  panicPrimary: { backgroundColor: colors.short },
  panicText: { color: colors.text, fontSize: 15, fontWeight: '800' },
});
