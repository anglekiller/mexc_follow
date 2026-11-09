import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { feePct } from '../api/fees';
import { liquidationPrices, maxLeverageForStop, mmrFor, tierFor } from '../api/liquidation';
import { INTERVAL_SECONDS, type ContractInfo, type KlineInterval, type NewOrder } from '../api/types';
import { Header } from '../components/Header';
import { LeveragePicker } from '../components/LeveragePicker';
import { PriceChart } from '../components/PriceChart';
import { SlidingSelector } from '../components/SlidingSelector';
import { SymbolPicker } from '../components/SymbolPicker';
import { failure, heavy, success, tap } from '../haptics';
import { errorMessage, floorToUnit, type Futures } from '../hooks/useFutures';
import { useKlines } from '../hooks/useKlines';
import { createStyles, colors, fmt, fmtVol, pairLabel, pnlColor, signed, sz, useGlass } from '../theme';

// MT5 timeframe names.
const INTERVALS: { value: KlineInterval; label: string }[] = [
  { value: 'Min1', label: 'M1' },
  { value: 'Min5', label: 'M5' },
  { value: 'Min15', label: 'M15' },
  { value: 'Min30', label: 'M30' },
  { value: 'Min60', label: 'H1' },
  { value: 'Hour4', label: 'H4' },
  { value: 'Day1', label: 'D1' },
  { value: 'Week1', label: 'W1' },
  { value: 'Month1', label: 'MN' },
];
const LEVERAGE_PRESETS = [10, 20, 50, 100];
const PERCENTS = [0.1, 0.25, 0.5, 1];
/** Share of equity to risk per trade. */
const RISK_PERCENTS = [0.005, 0.01, 0.02, 0.03];

type OrderKind = 'limit' | 'market';
/** usdt: margin, cont: order unit, risk: USDT lost if the stop-loss is hit. */
type Unit = 'usdt' | 'cont' | 'risk';

const num = (s: string) => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** An order plan handed over from another tab (e.g. Tín hiệu → "Đặt lệnh theo kế hoạch"). */
export interface TradePreset {
  symbol: string;
  entry: number;
  sl: number;
  tp?: number;
}

export function TradeScreen({ f, preset, onPresetUsed }: { f: Futures; preset?: TradePreset | null; onPresetUsed?: () => void }) {
  const ex = f.api;
  const [symbol, setSymbol] = useState(() => preset?.symbol ?? ex?.defaultSymbols[0] ?? 'BTC_USDT');
  const [recent, setRecent] = useState<string[]>(() =>
    [...new Set([preset?.symbol, ex?.defaultSymbols[0]].filter((x): x is string => !!x))],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [interval, setChartInterval] = useState<KlineInterval>('Min15');
  // Page scroll is paused while a chart gesture (scroll / crosshair / pinch) is active.
  const [chartBusy, setChartBusy] = useState(false);
  const [contract, setContract] = useState<ContractInfo | null>(null);
  const [contractErr, setContractErr] = useState<string | null>(null);
  const [kind, setKind] = useState<OrderKind>('limit');
  // A preset's entry replaces the mark-price prefill once its contract is loaded.
  const presetEntry = useRef(preset ? { symbol: preset.symbol, price: preset.entry } : null);
  useEffect(() => {
    if (preset) onPresetUsed?.();
    // Only on mount: the preset initialises the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [openType, setOpenType] = useState<1 | 2>(1);
  const [leverage, setLeverage] = useState(10);
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<Unit>(preset ? 'risk' : 'usdt');
  const [withTpSl, setWithTpSl] = useState(!!preset?.tp);
  const [tp, setTp] = useState(preset?.tp ? String(preset.tp) : '');
  const [sl, setSl] = useState(preset ? String(preset.sl) : '');
  const [submitting, setSubmitting] = useState<1 | 3 | null>(null);
  const [levOpen, setLevOpen] = useState(false);

  const { watchSymbol, ensureContract } = f;
  useEffect(() => {
    watchSymbol(symbol);
    return () => watchSymbol(null);
  }, [symbol, watchSymbol]);

  useEffect(() => {
    let alive = true;
    setContract(null);
    setContractErr(null);
    setPrice('');
    ensureContract(symbol)
      .then((c) => alive && setContract(c))
      .catch((e) => alive && setContractErr(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [symbol, ensureContract]);

  const mark = f.marks[symbol];
  const dp = contract?.priceScale ?? 2;

  // Prefill the limit price once per symbol.
  const prefilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (prefilledFor.current !== symbol && contract?.symbol === symbol) {
      const tick = contract.priceUnit || Math.pow(10, -contract.priceScale);
      const round = (v: number) => (Math.round(v / tick) * tick).toFixed(contract.priceScale);
      if (presetEntry.current?.symbol === symbol) {
        prefilledFor.current = symbol;
        setPrice(round(presetEntry.current.price));
        // Plan prices come from indicators: snap SL / TP to the price tick too.
        setSl((v) => (v ? round(parseFloat(v)) : v));
        setTp((v) => (v ? round(parseFloat(v)) : v));
        presetEntry.current = null;
      } else if (mark) {
        prefilledFor.current = symbol;
        setPrice(mark.toFixed(contract.priceScale));
      }
    }
  }, [mark, contract, symbol]);

  // Keep leverage in the contract's allowed range.
  useEffect(() => {
    if (contract) setLeverage((l) => Math.min(Math.max(l, contract.minLeverage), contract.maxLeverage));
  }, [contract]);

  const quickSymbols = useMemo(
    () => [...new Set([...recent, ...f.positions.map((p) => p.symbol), ...(ex?.defaultSymbols ?? [])])].slice(0, 10),
    [recent, f.positions, ex],
  );

  const { candles, ticker, loading: chartLoading } = useKlines(f.api, symbol, interval, mark);

  const held = f.positions.filter((p) => p.symbol === symbol);
  // Keyed by value: a new array on every render would redraw the memoized chart on each keystroke.
  const heldKey = held.map((p) => `${p.positionType}:${p.holdAvgPrice}:${p.liquidatePrice}`).join('|');
  const chartMarks = useMemo(
    () =>
      held.flatMap((p) => [
        { price: p.holdAvgPrice, color: p.positionType === 1 ? colors.long : colors.short, label: `Vào ${p.positionType === 1 ? 'Long' : 'Short'}` },
        { price: p.liquidatePrice, color: colors.warn, label: 'Thanh lý' },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heldKey],
  );
  const available = f.asset?.availableBalance ?? 0;
  const equity = f.asset?.equity || available;
  const px = kind === 'limit' ? num(price) : (mark ?? 0);
  const amt = num(amount);
  const isRisk = unit === 'risk';
  // Risk mode always needs a stop-loss; otherwise SL is only used when TP/SL is enabled.
  const slPrice = isRisk || withTpSl ? num(sl) : 0;
  const slDist = slPrice > 0 && px > 0 ? Math.abs(px - slPrice) : 0;
  const slPct = px > 0 ? slDist / px : 0;

  // Fees (MEXC publishes them per pair). A limit order is assumed to rest (maker); the stop-loss
  // and market orders pay taker.
  const makerFee = contract?.makerFeeRate;
  const takerFee = contract?.takerFeeRate;
  const hasFees = makerFee !== undefined && takerFee !== undefined;
  const zeroFee = hasFees && makerFee === 0 && takerFee === 0;
  const openFeeRate = hasFees ? (kind === 'limit' ? makerFee : takerFee) : 0;
  const closeFeeRate = takerFee ?? 0;

  const vol = useMemo(() => {
    if (!contract || px <= 0 || amt <= 0) return 0;
    let raw: number;
    if (unit === 'cont') raw = amt;
    else if (unit === 'usdt') raw = (amt * leverage) / (px * contract.contractSize);
    // Risk per coin at the stop = price distance + open fee + close fee at the stop price.
    else if (slDist > 0) raw = amt / ((slDist + px * openFeeRate + slPrice * closeFeeRate) * contract.contractSize);
    else return 0;
    return floorToUnit(raw, contract.volUnit, contract.volScale);
  }, [contract, px, amt, unit, leverage, slDist, slPrice, openFeeRate, closeFeeRate]);

  const coinQty = contract ? vol * contract.contractSize : 0;
  const unitName = contract?.contractSize === 1 ? contract.baseCoin : 'Cont';
  const notional = coinQty * px;
  const margin = leverage > 0 ? notional / leverage : 0;
  const openFee = notional * openFeeRate;
  const closeFeeAtSl = coinQty * slPrice * closeFeeRate;
  // Loss at the stop including fees (uses the rounded volume actually sent).
  const slLoss = coinQty * slDist + openFee + closeFeeAtSl;
  // Lowest leverage whose margin fits the available balance.
  const minLeverage = available > 0 ? Math.ceil(notional / available) : 0;
  const canRaiseLeverage = !!contract && minLeverage > leverage && minLeverage <= contract.maxLeverage;

  // Estimated liquidation for the order being entered (maintenance rate from the volume's risk tier).
  const tier = contract ? tierFor(contract, vol) : undefined;
  const mmr = contract ? mmrFor(contract, vol) : 0;
  const liqAt = (lev: number) =>
    liquidationPrices({ entry: px, qty: coinQty, leverage: lev, mmr, openType, available });
  const liq = vol > 0 ? liqAt(leverage) : null;
  // A stop-loss tells the side: below the entry → Long, above → Short.
  const slSide: 'long' | 'short' | null = slDist > 0 ? (slPrice < px ? 'long' : 'short') : null;
  const slBeyondLiq =
    !!liq && !!slSide && (slSide === 'long' ? liq.long > 0 && slPrice <= liq.long : slPrice >= liq.short);
  const safeLev = slBeyondLiq && openType === 1 ? maxLeverageForStop(px, slPrice, mmr) : null;
  const maxSafeLeverage = safeLev ? Math.max(safeLev, contract?.minLeverage ?? 1) : 0;
  const liqText = (p: number, side: 'long' | 'short') =>
    side === 'long' && p <= 0
      ? 'không bị thanh lý'
      : `${fmt(p, dp)} (${side === 'long' ? '−' : '+'}${fmt((Math.abs(px - p) / px) * 100, 2)}%)`;

  const problem = !contract
    ? null
    : kind === 'limit' && px <= 0
      ? 'Nhập giá đặt'
      : isRisk && slPrice <= 0
        ? 'Nhập giá cắt lỗ (SL) để tính khối lượng'
        : isRisk && slDist <= 0
          ? 'SL phải khác giá vào'
          : amt <= 0
        ? isRisk ? 'Nhập số tiền chấp nhận lỗ' : 'Nhập khối lượng'
        : vol < contract.minVol
          ? `Tối thiểu ${fmtVol(contract.minVol, contract)} (≈ ${fmt((contract.minVol * contract.contractSize * px) / leverage, 2)} USDT margin)`
          : vol > contract.maxVol
            ? `Tối đa ${fmtVol(contract.maxVol, contract)}`
            : contract.minNotional && notional < contract.minNotional
              ? `Giá trị lệnh tối thiểu ${contract.minNotional} USDT`
              : tier && leverage > tier.maxLeverage
                ? `Khối lượng này chỉ cho tối đa ${tier.maxLeverage}x`
              : margin > available
                ? canRaiseLeverage
                  ? `Vượt số dư khả dụng — cần đòn bẩy ≥ ${minLeverage}x`
                  : 'Vượt số dư khả dụng'
                : null;

  const chooseSymbol = (s: string) => {
    const n = ex ? ex.normalizeSymbol(s) : s;
    setPickerOpen(false);
    if (!n || n === symbol) return;
    tap();
    setSymbol(n);
    setRecent((r) => [n, ...r.filter((x) => x !== n)].slice(0, 6));
  };

  const setPercent = (pct: number) => {
    tap();
    setUnit('usdt');
    // Leave room for fees on 100%.
    setAmount(String(Math.floor(available * (pct === 1 ? 0.98 : pct) * 100) / 100));
  };

  const setRiskPercent = (pct: number) => {
    tap();
    setAmount(String(Math.floor(equity * pct * 100) / 100));
  };

  const changeUnit = (u: Unit) => {
    if (u === unit) return;
    setUnit(u);
    setAmount('');
  };

  const submit = (side: 1 | 3) => {
    if (!contract || problem) return;
    const isLong = side === 1;
    const tpPrice = withTpSl ? num(tp) : 0;
    if (tpPrice > 0 && (isLong ? tpPrice <= px : tpPrice >= px))
      return Alert.alert('TP không hợp lệ', `TP phải ${isLong ? 'cao hơn' : 'thấp hơn'} giá vào.`);
    if (slPrice > 0 && (isLong ? slPrice >= px : slPrice <= px))
      return Alert.alert('SL không hợp lệ', `SL phải ${isLong ? 'thấp hơn' : 'cao hơn'} giá vào.`);

    const order: NewOrder = {
      symbol,
      side,
      type: kind === 'limit' ? 1 : 5,
      openType,
      price: Number(px.toFixed(dp)),
      vol,
      leverage,
      ...(tpPrice > 0 && { takeProfitPrice: tpPrice }),
      ...(slPrice > 0 && { stopLossPrice: slPrice }),
    };

    heavy();
    Alert.alert(
      `${isLong ? 'Mở Long' : 'Mở Short'} ${pairLabel(symbol)} · ${ex?.name ?? ''}?`,
      [
        `${kind === 'limit' ? `Limit @ ${fmt(order.price, dp)}` : 'Market'} · ${leverage}x ${openType === 1 ? 'Isolated' : 'Cross'}`,
        contract.contractSize === 1 ? fmtVol(vol, contract) : `${fmtVol(vol, contract)} = ${fmt(coinQty, 6)} ${contract.baseCoin}`,
        `Giá trị ≈ ${fmt(notional, 2)} USDT · Margin ≈ ${fmt(margin, 2)} USDT`,
        hasFees ? (zeroFee ? 'Phí: 0 (cặp 0 phí)' : `Phí mở ≈ ${fmt(openFee, 4)} USDT (${feePct(openFeeRate)})`) : '',
        tpPrice > 0 ? `TP ${fmt(tpPrice, dp)}` : '',
        slPrice > 0
          ? `SL ${fmt(slPrice, dp)} · Lỗ nếu chạm SL ≈ ${fmt(slLoss, 2)} USDT (${fmt(equity > 0 ? (slLoss / equity) * 100 : 0, 2)}% vốn${hasFees ? ', đã gồm phí' : ', chưa gồm phí'})`
          : '',
        liq ? `Thanh lý ≈ ${liqText(isLong ? liq.long : liq.short, isLong ? 'long' : 'short')} (ước tính)` : '',
        slBeyondLiq && slSide === (isLong ? 'long' : 'short')
          ? `⚠ SL nằm sau giá thanh lý${maxSafeLeverage ? ` — nên giảm đòn bẩy ≤ ${maxSafeLeverage}x` : ''}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: isLong ? 'Mở Long' : 'Mở Short',
          onPress: async () => {
            setSubmitting(side);
            try {
              const id = await f.placeOrder(order);
              success();
              setAmount('');
              Alert.alert('Đã gửi lệnh', `Mã lệnh: ${id}`);
            } catch (e) {
              failure();
              Alert.alert('Đặt lệnh thất bại', errorMessage(e));
            } finally {
              setSubmitting(null);
            }
          },
        },
      ],
    );
  };

  const canSubmit = !!contract && !problem && submitting === null;

  return (
    <View style={styles.screen}>
      <Header title="Giao dịch" ws={f.wsStatus} />

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" scrollEnabled={!chartBusy}>
        {/* Symbol: tap to open the pair picker */}
        <Pressable onPress={() => setPickerOpen(true)} style={({ pressed }) => [styles.symbolRow, pressed && { opacity: 0.7 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.symbol}>
              {ex ? ex.baseOf(symbol) : symbol}
              <Text style={styles.quote}>/USDT</Text> <Text style={styles.caret}>▾</Text>
            </Text>
            <Text style={styles.muted}>
              {ex?.name ?? ''} Perpetual
              {hasFees && (
                <Text style={{ color: zeroFee ? colors.long : colors.muted, fontWeight: zeroFee ? '700' : '400' }}>
                  {'  '}
                  {zeroFee ? '0 phí' : `Phí ${feePct(makerFee!)} / ${feePct(takerFee!)}`}
                </Text>
              )}
              {ticker && (
                <Text style={{ color: pnlColor(ticker.riseFallRate) }}>  {signed(ticker.riseFallRate * 100)}% 24h</Text>
              )}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.mark, ticker && { color: pnlColor(ticker.riseFallRate) }]}>{mark ? fmt(mark, dp) : '—'}</Text>
            <Text style={styles.muted}>
              {ticker ? `H ${fmt(ticker.high24Price, dp)} · L ${fmt(ticker.lower24Price, dp)}` : 'Giá đánh dấu'}
            </Text>
          </View>
        </Pressable>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label="☰ Tất cả cặp" onPress={() => setPickerOpen(true)} small />
          {quickSymbols.map((s) => (
            <Chip key={s} label={ex ? ex.baseOf(s) : s} active={s === symbol} onPress={() => chooseSymbol(s)} small />
          ))}
        </ScrollView>

        {/* Chart */}
        <View style={styles.chartCard}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.intervals}>
            {INTERVALS.map((i) => (
              <Pressable
                key={i.value}
                onPress={() => {
                  tap();
                  setChartInterval(i.value);
                }}
                style={[styles.interval, interval === i.value && styles.intervalActive]}
              >
                <Text style={[styles.intervalText, interval === i.value && { color: colors.text }]}>{i.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <PriceChart
            candles={candles}
            height={sz(230)}
            priceScale={dp}
            intervalSec={INTERVAL_SECONDS[interval]}
            loading={chartLoading}
            marks={chartMarks}
            onGestureActive={setChartBusy}
          />
        </View>

        {contractErr && <Text style={styles.error}>{contractErr}</Text>}
        {!contract && !contractErr && <ActivityIndicator color={colors.muted} style={{ marginVertical: 12 }} />}

        {held.map((p) => (
          <Text key={p.positionId} style={styles.held}>
            Đang giữ:{' '}
            <Text style={{ color: p.positionType === 1 ? colors.long : colors.short, fontWeight: '700' }}>
              {p.positionType === 1 ? 'Long' : 'Short'} {fmtVol(p.holdVol, p.contract)}
            </Text>{' '}
            @ {fmt(p.holdAvgPrice, dp)}
          </Text>
        ))}

        {/* Margin mode + order type share a row to keep the form short on small screens */}
        <View style={styles.pairRow}>
          <View style={styles.pairItem}>
            <Segmented
              options={[
                { value: 1, label: 'Isolated' },
                { value: 2, label: 'Cross' },
              ]}
              value={openType}
              onChange={setOpenType}
            />
          </View>
          <View style={styles.pairItem}>
            <Segmented
              options={[
                { value: 'limit', label: 'Limit' },
                { value: 'market', label: 'Market' },
              ]}
              value={kind}
              onChange={setKind}
            />
          </View>
        </View>

        <View style={styles.levRow}>
          <Text style={styles.levLabel}>Đòn bẩy</Text>
          <Stepper label="−" onPress={() => setLeverage((l) => Math.max(l - 1, contract?.minLeverage ?? 1))} />
          <Pressable
            onPress={() => {
              tap();
              setLevOpen(true);
            }}
            style={({ pressed }) => [styles.levButton, pressed && { opacity: 0.6 }]}
          >
            <Text style={[styles.levValue, leverage >= 50 && { color: colors.warn }]}>{leverage}x</Text>
            <Text style={styles.caret}>▾</Text>
          </Pressable>
          <Stepper label="+" onPress={() => setLeverage((l) => Math.min(l + 1, contract?.maxLeverage ?? 125))} />
        </View>
        <View style={styles.levPresets}>
          {LEVERAGE_PRESETS.filter((l) => !contract || l < contract.maxLeverage).map((l) => (
            <Chip key={l} label={`${l}x`} active={leverage === l} onPress={() => setLeverage(l)} small grow />
          ))}
          {contract && (
            <Chip
              label="Max"
              active={leverage === contract.maxLeverage}
              onPress={() => setLeverage(contract.maxLeverage)}
              small
              grow
            />
          )}
        </View>

        {kind === 'limit' ? (
          <Field
            label="Giá (USDT)"
            value={price}
            onChange={setPrice}
            action={{ label: 'Giá hiện tại', onPress: () => mark && setPrice(mark.toFixed(dp)) }}
          />
        ) : (
          <Text style={styles.marketNote}>Khớp ngay theo giá thị trường tốt nhất.</Text>
        )}

        {/* Amount */}
        <Segmented
          options={[
            { value: 'usdt', label: 'Margin' },
            { value: 'cont', label: unitName },
            { value: 'risk', label: '% Rủi ro' },
          ]}
          value={unit}
          onChange={changeUnit}
        />
        {isRisk && (
          <Field
            label={`Giá cắt lỗ SL${slPct > 0 ? ` · cách giá vào ${fmt(slPct * 100, 2)}%` : ''}`}
            value={sl}
            onChange={setSl}
            color={colors.short}
          />
        )}
        <Field
          label={
            isRisk
              ? `Chấp nhận lỗ (USDT)${equity > 0 && amt > 0 ? ` · ${fmt((amt / equity) * 100, 2)}% vốn` : ''}`
              : unit === 'usdt'
                ? 'Margin (USDT)'
                : `Khối lượng (${unitName})`
          }
          value={amount}
          onChange={setAmount}
        />
        <View style={styles.percentRow}>
          {isRisk
            ? RISK_PERCENTS.map((p) => <Chip key={p} label={`${p * 100}% vốn`} onPress={() => setRiskPercent(p)} grow />)
            : PERCENTS.map((p) => <Chip key={p} label={`${p * 100}%`} onPress={() => setPercent(p)} grow />)}
        </View>

        {/* TP / SL */}
        <Pressable onPress={() => setWithTpSl((v) => !v)} style={styles.toggle}>
          <View style={[styles.checkbox, withTpSl && styles.checkboxOn]}>{withTpSl && <Text style={styles.check}>✓</Text>}</View>
          <Text style={styles.toggleText}>Chốt lời / Cắt lỗ (TP/SL)</Text>
        </Pressable>
        {withTpSl && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Field label="TP" value={tp} onChange={setTp} color={colors.long} />
            </View>
            {/* In risk mode the SL is entered next to the amount. */}
            {!isRisk && (
              <View style={{ flex: 1 }}>
                <Field label="SL" value={sl} onChange={setSl} color={colors.short} />
              </View>
            )}
          </View>
        )}
        {withTpSl && slDist > 0 && num(tp) > 0 && px > 0 && (
          <Text style={styles.rr}>R:R ≈ 1 : {fmt(Math.abs(num(tp) - px) / slDist, 2)}</Text>
        )}

        <View style={styles.summary}>
          <Row label={isRisk ? 'Vốn (equity)' : 'Khả dụng'} value={`${fmt(isRisk ? equity : available, 2)} USDT`} />
          <Row label="Khối lượng" value={contract?.contractSize === 1 ? fmtVol(vol, contract) : `${fmtVol(vol, contract)} · ${fmt(coinQty, 6)} ${contract?.baseCoin ?? ''}`} />
          <Row label="Giá trị lệnh" value={`${fmt(notional, 2)} USDT`} />
          <Row label="Margin cần" value={`${fmt(margin, 2)} USDT${isRisk ? ` / ${fmt(available, 2)} khả dụng` : ''}`} />
          {hasFees && (
            <Row
              label={`Phí mở (${kind === 'limit' ? 'Maker' : 'Taker'})`}
              value={zeroFee ? '0 USDT · cặp 0 phí' : `≈ ${fmt(openFee, 4)} USDT · ${feePct(openFeeRate)}`}
              color={zeroFee ? colors.long : undefined}
            />
          )}
          {hasFees && !zeroFee && vol > 0 && (
            <Row label="Phí đóng (Taker)" value={`≈ ${fmt(coinQty * (slPrice || px) * closeFeeRate, 4)} USDT · ${feePct(closeFeeRate)}`} />
          )}
          {slDist > 0 && vol > 0 && (
            <Row
              label="Lỗ nếu chạm SL" 
              value={`≈ ${fmt(slLoss, 2)} USDT${equity > 0 ? ` · ${fmt((slLoss / equity) * 100, 2)}% vốn` : ''}`}
              color={colors.short}
            />
          )}
          {isRisk && margin > available && canRaiseLeverage && (
            <Text style={styles.hint}>
              Margin vượt số dư.{' '}
              <Text style={styles.hintAction} onPress={() => setLeverage(minLeverage)}>
                Đặt {minLeverage}x
              </Text>
            </Text>
          )}
          {liq && (slSide ?? 'long') === 'long' && (
            <Row label="Thanh lý Long ≈" value={liqText(liq.long, 'long')} color={colors.warn} />
          )}
          {liq && (slSide ?? 'short') === 'short' && (
            <Row label="Thanh lý Short ≈" value={liqText(liq.short, 'short')} color={colors.warn} />
          )}
          {liq && (
            <Text style={styles.muted}>
              Ước tính · MMR {fmt(mmr * 100, 2)}%{openType === 2 ? ' · Cross: tính theo toàn bộ số dư khả dụng' : ''}
            </Text>
          )}
          {slBeyondLiq && (
            <Text style={styles.hint}>
              ⚠ SL cách {fmt(slPct * 100, 2)}% nằm sau giá thanh lý — sẽ bị thanh lý trước khi chạm SL.{' '}
              {maxSafeLeverage > 0 && maxSafeLeverage < leverage && (
                <Text style={styles.hintAction} onPress={() => setLeverage(maxSafeLeverage)}>
                  Giảm về {maxSafeLeverage}x
                </Text>
              )}
            </Text>
          )}
          {vol > 0 && (
            <Text style={styles.muted}>
              {hasFees
                ? `Lỗ khi chạm SL đã gồm phí mở + đóng; chưa gồm trượt giá, funding.${kind === 'limit' ? ' Lệnh Limit khớp ngay sẽ tính phí Taker.' : ''}`
                : 'Sàn không công bố phí qua API: các con số chưa gồm phí, trượt giá.'}
            </Text>
          )}
        </View>
      </ScrollView>

      <LeveragePicker
        visible={levOpen}
        value={leverage}
        min={contract?.minLeverage ?? 1}
        max={contract?.maxLeverage ?? 125}
        describe={(lev) => {
          // In margin mode the size scales with leverage; otherwise it is fixed.
          const q = unit === 'usdt' ? (px > 0 ? (amt * lev) / px : 0) : coinQty;
          const l = q > 0 ? liquidationPrices({ entry: px, qty: q, leverage: lev, mmr, openType, available }) : null;
          const tierMax = tier && lev > tier.maxLeverage ? ` · khối lượng hiện tại chỉ cho tối đa ${tier.maxLeverage}x` : '';
          if (!l) return `Isolated: thanh lý khi giá đi ngược ≈ ${fmt((1 / lev - mmr) * 100, 2)}%${tierMax}`;
          return `Thanh lý ≈ Long ${liqText(l.long, 'long')} · Short ${liqText(l.short, 'short')}${tierMax}`;
        }}
        onConfirm={(l) => {
          setLeverage(l);
          setLevOpen(false);
        }}
        onClose={() => setLevOpen(false)}
      />

      <SymbolPicker
        api={f.api}
        visible={pickerOpen}
        current={symbol}
        pinned={[...new Set(f.positions.map((p) => p.symbol))]}
        onSelect={chooseSymbol}
        onClose={() => setPickerOpen(false)}
      />

      {/* Actions */}
      <View style={styles.actionBar}>
        {/* Always rendered: the buttons must not shift under the finger when a problem appears. */}
        <Text style={styles.problem} numberOfLines={1} adjustsFontSizeToFit>
          {problem ?? ' '}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {([1, 3] as const).map((side) => (
            <Pressable
              key={side}
              onPress={() => submit(side)}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.sideBtn,
                { backgroundColor: side === 1 ? colors.long : colors.short },
                pressed && { opacity: 0.75 },
                !canSubmit && { opacity: 0.45 },
              ]}
            >
              {submitting === side ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.sideText}>{side === 1 ? 'Mở Long' : 'Mở Short'}</Text>
              )}
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

// ---------- Small building blocks ----------

function Chip({
  label,
  active,
  onPress,
  small,
  grow,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  small?: boolean;
  grow?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        small && styles.chipSmall,
        grow && { flex: 1 },
        active && styles.chipActive,
        pressed && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.chipText, small && styles.chipTextSmall, active && { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const glass = useGlass();
  return (
    <View style={[styles.segmented, glass && { borderRadius: 999 }]}>
      <SlidingSelector
        options={options}
        value={options.find((o) => o.value === value) ?? options[0]}
        onChange={(o) => onChange(o.value)}
        itemStyle={styles.segment}
        pillStyle={styles.segmentActive}
        renderItem={(o, active) => <Text style={[styles.segmentText, active && { color: colors.text }]}>{o.label}</Text>}
      />
    </View>
  );
}

function Stepper({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.stepper, pressed && { opacity: 0.6 }]}
    >
      <Text style={styles.stepperText}>{label}</Text>
    </Pressable>
  );
}

function Field({
  label,
  value,
  onChange,
  action,
  color,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  action?: { label: string; onPress: () => void };
  color?: string;
}) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={[styles.label, { marginTop: 0 }, color ? { color } : null]}>{label}</Text>
      <View style={styles.fieldRow}>
        <TextInput
          value={value}
          onChangeText={(t) => onChange(t.replace(',', '.'))}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        {action && (
          <Pressable onPress={action.onPress} style={styles.fieldAction}>
            <Text style={styles.fieldActionText}>{action.label}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.rowValue, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = createStyles({
  screen: { flex: 1, backgroundColor: colors.page },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  muted: { color: colors.muted, fontSize: 12 },
  symbolRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  symbol: { color: colors.text, fontSize: 22, fontWeight: '800' },
  mark: { color: colors.text, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chips: { gap: 6, paddingVertical: 10, alignItems: 'center' },
  chip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSmall: { height: 38, paddingHorizontal: 10, borderRadius: 8 },
  chipActive: { borderColor: colors.warn, backgroundColor: colors.warn + '1F' },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  chipTextSmall: { fontSize: 13 },
  caret: { color: colors.muted, fontSize: 16 },
  quote: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  chartCard: { backgroundColor: colors.card, borderRadius: 12, padding: 8, marginBottom: 6 },
  intervals: { gap: 2, marginBottom: 6 },
  interval: { paddingHorizontal: 11, height: 38, borderRadius: 6, justifyContent: 'center' },
  intervalActive: { backgroundColor: colors.cardAlt },
  intervalText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  error: { color: colors.short, fontSize: 13, marginBottom: 8 },
  held: { color: colors.muted, fontSize: 13, marginBottom: 8 },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 3,
    marginTop: 8,
  },
  segment: { height: 42, alignItems: 'center', justifyContent: 'center' },
  segmentActive: { borderRadius: 8, backgroundColor: colors.cardAlt },
  segmentText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  label: { color: colors.muted, fontSize: 12, marginTop: 14, marginBottom: 6 },
  pairRow: { flexDirection: 'row', gap: 8 },
  pairItem: { flex: 1 },
  levRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  levLabel: { flex: 1, color: colors.muted, fontSize: 13 },
  levPresets: { flexDirection: 'row', gap: 6, marginTop: 8 },
  stepper: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: { color: colors.text, fontSize: 20, fontWeight: '600' },
  levButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  levValue: { color: colors.text, fontSize: 18, fontWeight: '700', minWidth: 40, textAlign: 'center' },
  marketNote: { color: colors.muted, fontSize: 13, marginTop: 12 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    height: 48,
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 17,
    fontVariant: ['tabular-nums'],
  },
  fieldAction: {
    height: 48,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
    justifyContent: 'center',
  },
  fieldActionText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  percentRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  summary: { marginTop: 14, padding: 12, borderRadius: 10, backgroundColor: colors.card, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowValue: { color: colors.text, fontSize: 13, flexShrink: 1, fontVariant: ['tabular-nums'] },
  hint: { color: colors.warn, fontSize: 12 },
  hintAction: { color: colors.accent, fontWeight: '700' },
  rr: { color: colors.muted, fontSize: 12, marginTop: 6 },
  toggle: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 10 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.warn, borderColor: colors.warn },
  check: { color: colors.bg, fontSize: 14, fontWeight: '900' },
  toggleText: { color: colors.text, fontSize: 14 },
  actionBar: { paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderColor: colors.border },
  problem: { color: colors.warn, fontSize: 12, textAlign: 'center', marginBottom: 6 },
  sideBtn: { flex: 1, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sideText: { color: colors.text, fontSize: 16, fontWeight: '800' },
});
