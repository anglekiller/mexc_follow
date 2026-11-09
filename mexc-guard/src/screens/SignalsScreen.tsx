import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { requestNotificationPermission } from '../alerts/notify';
import { Header } from '../components/Header';
import { success, tap } from '../haptics';
import type { Futures } from '../hooks/useFutures';
import { aiPlan, type AiPlan } from '../signals/ai';
import { analyze, type MarketView, type Trend } from '../signals/analyze';
import { loadSignalSettings, saveSignalSettings, type SignalSettings } from '../signals/background';
import { INSTRUMENTS, symbolFor, type InstrumentId } from '../signals/instruments';
import { createStyles, colors, fmt, pnlColor, signed } from '../theme';
import type { TradePreset } from './TradeScreen';

const REFRESH_MS = 60_000;

const TREND: Record<Trend, { label: string; color: string }> = {
  up: { label: '↗ Tăng', color: colors.long },
  down: { label: '↘ Giảm', color: colors.short },
  flat: { label: '→ Đi ngang', color: colors.muted },
};

/** Decimals that keep ~5 significant digits for the price level. */
const dpFor = (p: number) => (p >= 1000 ? 2 : p >= 10 ? 3 : 4);

interface Props {
  f: Futures;
  onPlan: (p: TradePreset) => void;
}

export function SignalsScreen({ f, onPlan }: Props) {
  const api = f.api;
  const [views, setViews] = useState<Partial<Record<InstrumentId, MarketView | null>>>({});
  const [errors, setErrors] = useState<Partial<Record<InstrumentId, string>>>({});
  const [plans, setPlans] = useState<Partial<Record<InstrumentId, AiPlan>>>({});
  const [asking, setAsking] = useState<InstrumentId | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState<SignalSettings | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!api) return;
    await Promise.all(
      INSTRUMENTS.map(async (inst) => {
        try {
          const v = await analyze(api, inst);
          if (!alive.current) return;
          setViews((o) => ({ ...o, [inst.id]: v }));
          setErrors((o) => ({ ...o, [inst.id]: undefined }));
        } catch (e) {
          if (alive.current) setErrors((o) => ({ ...o, [inst.id]: e instanceof Error ? e.message : String(e) }));
        }
      }),
    );
  }, [api]);

  useEffect(() => {
    alive.current = true;
    loadSignalSettings().then(setSettings);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load]);

  const toggleNotify = async () => {
    if (!settings) return;
    if (!settings.enabled && !(await requestNotificationPermission()))
      return Alert.alert('Chưa cho phép thông báo', 'Bật quyền thông báo cho MEXC Guard trong Cài đặt của máy.');
    const next = { ...settings, enabled: !settings.enabled };
    setSettings(next);
    await saveSignalSettings(next);
    success();
  };

  const toggleInstrument = async (id: InstrumentId) => {
    if (!settings) return;
    tap();
    const has = settings.instruments.includes(id);
    const next = { ...settings, instruments: has ? settings.instruments.filter((x) => x !== id) : [...settings.instruments, id] };
    setSettings(next);
    await saveSignalSettings(next);
  };

  const ask = async (id: InstrumentId) => {
    const v = views[id];
    if (!v) return;
    tap();
    setAsking(id);
    try {
      const p = await aiPlan(v);
      setPlans((o) => ({ ...o, [id]: p }));
    } catch (e) {
      Alert.alert('Phân tích AI thất bại', e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(null);
    }
  };

  const applyPlan = (symbol: string, entry: number, sl: number, tp?: number) => {
    tap();
    onPlan({ symbol, entry, sl, tp });
  };

  if (!api) return null;

  return (
    <View style={styles.screen}>
      <Header title="Tín hiệu" ws={f.wsStatus} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={colors.muted}
          />
        }
      >
        {settings && (
          <View style={styles.notifyCard}>
            <Pressable onPress={toggleNotify} style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchTitle}>🔔 Nhắc khi có điểm vào lệnh</Text>
                <Text style={styles.muted}>Kiểm tra 5 phút/lần (cả khi đóng app nếu có widget tự cập nhật). Mỗi tín hiệu nhắc tối đa 3 giờ/lần.</Text>
              </View>
              <View style={[styles.track, settings.enabled && { backgroundColor: colors.long }]}>
                <View style={[styles.thumb, settings.enabled && styles.thumbOn]} />
              </View>
            </Pressable>
            {settings.enabled && (
              <View style={styles.instRow}>
                {INSTRUMENTS.map((i) => {
                  const on = settings.instruments.includes(i.id);
                  return (
                    <Pressable key={i.id} onPress={() => toggleInstrument(i.id)} style={[styles.instChip, on && styles.instChipOn]}>
                      <Text style={[styles.instChipText, on && { color: colors.text }]}>
                        {i.icon} {i.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {INSTRUMENTS.map((inst) => {
          const symbol = symbolFor(api.id, inst.id);
          const v = views[inst.id];
          const err = errors[inst.id];
          const plan = plans[inst.id];
          if (!symbol)
            return (
              <View key={inst.id} style={styles.card}>
                <Text style={styles.name}>
                  {inst.icon} {inst.name}
                </Text>
                <Text style={styles.muted}>{api.name} không có hợp đồng {inst.name}.</Text>
              </View>
            );
          if (!v)
            return (
              <View key={inst.id} style={styles.card}>
                <Text style={styles.name}>
                  {inst.icon} {inst.name}
                </Text>
                {err ? <Text style={styles.bad}>{err}</Text> : <ActivityIndicator color={colors.muted} style={{ marginTop: 10 }} />}
              </View>
            );
          const dp = dpFor(v.price);
          const px = (n: number) => fmt(n, dp);
          const s = v.setup;
          const atrPct = (v.atrH1 / v.price) * 100;
          return (
            <View key={inst.id} style={styles.card}>
              <View style={styles.headRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>
                    {inst.icon} {inst.name} <Text style={styles.symbol}>{api.baseOf(symbol)}</Text>
                  </Text>
                  <Text style={[styles.trend, { color: TREND[v.trendH4].color }]}>H4 {TREND[v.trendH4].label}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.price}>{px(v.price)}</Text>
                  <Text style={[styles.change, { color: pnlColor(v.change24) }]}>{signed(v.change24)}% 24h</Text>
                </View>
              </View>

              <View style={styles.grid}>
                <Stat
                  label="RSI H1"
                  value={fmt(v.rsiH1, 0)}
                  color={v.rsiH1 >= 70 ? colors.short : v.rsiH1 <= 30 ? colors.long : undefined}
                />
                <Stat label="ATR H1" value={`${fmt(atrPct, 2)}%`} />
                <Stat label="EMA20 H1" value={px(v.ema20H1)} />
              </View>
              <View style={styles.grid}>
                <Stat label="Hỗ trợ (5 ngày)" value={px(v.support)} color={colors.long} />
                <Stat label="Kháng cự (5 ngày)" value={px(v.resistance)} color={colors.short} />
                <Stat label="Đáy / Đỉnh 24h" value={`${px(v.low24)} / ${px(v.high24)}`} />
              </View>

              {/* Rule-based setup */}
              {s ? (
                <View
                  style={[
                    styles.setup,
                    { borderColor: s.kind === 'extended' ? colors.warn : s.side === 'long' ? colors.long : colors.short },
                  ]}
                >
                  <Text style={[styles.setupTitle, { color: s.kind === 'extended' ? colors.warn : s.side === 'long' ? colors.long : colors.short }]}>
                    {s.kind === 'extended' ? '⚠️' : '🎯'} {s.title}
                  </Text>
                  <Text style={styles.setupText}>{s.reason}</Text>
                  {s.plan && (
                    <>
                      <Text style={styles.planText}>
                        Vào ~{px(s.plan.entry)} · <Text style={{ color: colors.short }}>SL {px(s.plan.sl)}</Text> ·{' '}
                        <Text style={{ color: colors.long }}>
                          TP {px(s.plan.tp1)} / {px(s.plan.tp2)}
                        </Text>
                      </Text>
                      <Pressable onPress={() => applyPlan(symbol, s.plan!.entry, s.plan!.sl, s.plan!.tp1)} style={styles.planBtn}>
                        <Text style={styles.planBtnText}>Đặt lệnh theo kế hoạch ›</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              ) : (
                <Text style={[styles.muted, { marginTop: 10 }]}>
                  Chưa có điểm vào rõ ràng theo quy tắc. Chờ giá hồi về EMA20 H1 ({px(v.ema20H1)}) hoặc phá vùng 24h.
                </Text>
              )}

              {/* Gemini plan */}
              {plan && (
                <View style={styles.ai}>
                  <View style={styles.aiHead}>
                    <Text
                      style={[
                        styles.bias,
                        { color: plan.bias === 'LONG' ? colors.long : plan.bias === 'SHORT' ? colors.short : colors.warn },
                      ]}
                    >
                      AI: {plan.bias === 'LONG' ? 'Canh Long' : plan.bias === 'SHORT' ? 'Canh Short' : 'Đứng ngoài'}
                    </Text>
                    <Text style={styles.muted}>Tin cậy {plan.confidence}%</Text>
                  </View>
                  {plan.bias !== 'WAIT' && plan.sl && (
                    <Text style={styles.planText}>
                      Vào {plan.entryLow ? px(plan.entryLow) : '—'}
                      {plan.entryHigh && plan.entryHigh !== plan.entryLow ? `–${px(plan.entryHigh)}` : ''} ·{' '}
                      <Text style={{ color: colors.short }}>SL {px(plan.sl)}</Text>
                      {plan.tp1 ? (
                        <Text style={{ color: colors.long }}>
                          {' '}
                          · TP {px(plan.tp1)}
                          {plan.tp2 ? ` / ${px(plan.tp2)}` : ''}
                        </Text>
                      ) : null}
                    </Text>
                  )}
                  <Text style={styles.setupText}>{plan.reason}</Text>
                  {plan.risks ? <Text style={[styles.setupText, { color: colors.warn }]}>Rủi ro: {plan.risks}</Text> : null}
                  <Text style={styles.model}>{plan.model.replace('models/', '')}</Text>
                  {plan.bias !== 'WAIT' && plan.sl && (plan.entryLow || plan.entryHigh) && (
                    <Pressable
                      onPress={() => {
                        const lo = plan.entryLow ?? plan.entryHigh!;
                        const hi = plan.entryHigh ?? lo;
                        // Limit order at the middle of the AI entry zone.
                        applyPlan(symbol, (lo + hi) / 2, plan.sl!, plan.tp1);
                      }}
                      style={styles.planBtn}
                    >
                      <Text style={styles.planBtnText}>Dùng kế hoạch AI ›</Text>
                    </Pressable>
                  )}
                </View>
              )}

              <Pressable onPress={() => ask(inst.id)} disabled={asking !== null} style={[styles.aiBtn, asking !== null && { opacity: 0.6 }]}>
                {asking === inst.id ? (
                  <ActivityIndicator color={colors.text} />
                ) : (
                  <Text style={styles.aiBtnText}>🤖 {plan ? 'Phân tích lại' : 'Phân tích AI'}</Text>
                )}
              </Pressable>
            </View>
          );
        })}

        <Text style={styles.disclaimer}>
          Tín hiệu theo quy tắc kỹ thuật (EMA, RSI, ATR) và gợi ý AI chỉ để tham khảo — không phải lời khuyên tài chính. Luôn đặt SL.
        </Text>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

const styles = createStyles({
  screen: { flex: 1, backgroundColor: colors.page },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  bad: { color: colors.short, fontSize: 13, marginTop: 8 },
  notifyCard: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginTop: 4, marginBottom: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 3 },
  track: { width: 46, height: 26, borderRadius: 13, backgroundColor: colors.cardAlt, padding: 3 },
  thumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.muted },
  thumbOn: { backgroundColor: colors.text, marginLeft: 20 },
  instRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  instChip: {
    flex: 1,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  instChipOn: { borderColor: colors.warn, backgroundColor: colors.warn + '1F' },
  instChipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 10 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start' },
  name: { color: colors.text, fontSize: 18, fontWeight: '800' },
  symbol: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  trend: { fontSize: 13, fontWeight: '700', marginTop: 2 },
  price: { color: colors.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  change: { fontSize: 12, fontWeight: '700', marginTop: 2 },
  grid: { flexDirection: 'row', gap: 8, marginTop: 10 },
  statValue: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  setup: { borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 12 },
  setupTitle: { fontSize: 14, fontWeight: '800' },
  setupText: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 4 },
  planText: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 6, fontVariant: ['tabular-nums'] },
  planBtn: { alignSelf: 'flex-start', marginTop: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.cardAlt },
  planBtnText: { color: colors.warn, fontSize: 13, fontWeight: '700' },
  ai: { backgroundColor: colors.bg, borderRadius: 10, padding: 10, marginTop: 10 },
  aiHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bias: { fontSize: 14, fontWeight: '800' },
  model: { color: colors.muted, fontSize: 10, marginTop: 6 },
  aiBtn: {
    height: 42,
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  aiBtnText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  disclaimer: { color: colors.muted, fontSize: 11, textAlign: 'center', marginTop: 6, lineHeight: 16 },
});
