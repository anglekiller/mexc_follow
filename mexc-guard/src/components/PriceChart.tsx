import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Pressable, Text, View, type GestureResponderEvent } from 'react-native';

import type { Candle } from '../api/types';
import { tap } from '../haptics';
import { colors, createStyles, fmt, fmtChartTime, sz, useGlass } from '../theme';

export type ChartType = 'candle' | 'bar' | 'line';

const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: 'candle', label: 'Nến' },
  { value: 'bar', label: 'Thanh' },
  { value: 'line', label: 'Đường' },
];

interface Props {
  candles: Candle[];
  height: number;
  priceScale: number;
  intervalSec: number;
  loading?: boolean;
  /** Horizontal lines, e.g. entry / liquidation price of a held position. */
  marks?: { price: number; color: string; label: string }[];
  /** True while the chart owns a gesture (scroll / crosshair / pinch): parent should stop scrolling. */
  onGestureActive?: (active: boolean) => void;
}

const AXIS_W = sz(64);
const TIME_H = sz(16);
const VOL_H = 0.14; // share of the plot used by volume bars
const PAD_Y = sz(10);
const MIN_ZOOM = 2;
const MAX_ZOOM = 24;
const LINE_COLOR = '#4FA3FF';
const LONG_PRESS_MS = 300;

// How far (in multiples of the candles' own range) a position line may stretch the price axis.
const MARK_REACH = 0.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const touchDistance = (e: GestureResponderEvent) => {
  const [a, b] = e.nativeEvent.touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
};

/**
 * MT5-style price chart drawn with plain Views: candles / OHLC bars / line, drag to scroll
 * history, pinch or +/- to zoom, long-press for a crosshair with OHLC readout.
 */
export const PriceChart = memo(function PriceChart({
  candles,
  height,
  priceScale,
  intervalSec,
  loading,
  marks = [],
  onGestureActive,
}: Props) {
  useGlass();
  const [type, setType] = useState<ChartType>('candle');
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(7); // candle body width in px
  const [offset, setOffset] = useState(0); // candles scrolled back from the latest
  const [cross, setCross] = useState<{ x: number; y: number } | null>(null);

  const gap = Math.max(1, Math.round(zoom * 0.35));
  const step = zoom + gap;
  const plotW = Math.max(width - AXIS_W, 0);
  const plotH = height - TIME_H;
  const priceH = plotH * (1 - VOL_H);
  const count = Math.max(Math.floor(plotW / step), 1);
  const maxOffset = Math.max(candles.length - count, 0);
  const off = Math.min(offset, maxOffset);

  const visible = useMemo(
    () => candles.slice(Math.max(candles.length - off - count, 0), candles.length - off),
    [candles, off, count],
  );

  const { hi, lo, maxVol } = useMemo(() => {
    let hi = -Infinity;
    let lo = Infinity;
    let maxVol = 0;
    for (const c of visible) {
      hi = Math.max(hi, type === 'line' ? c.close : c.high);
      lo = Math.min(lo, type === 'line' ? c.close : c.low);
      maxVol = Math.max(maxVol, c.vol);
    }
    if (!Number.isFinite(hi)) return { hi: 1, lo: 0, maxVol };
    // Pull a position line into view only when it sits near the candles; a far-away line
    // (e.g. cross-margin liquidation) would squash every candle into a flat line. Those are
    // pinned to the chart edge instead.
    const span = hi - lo;
    for (const m of marks) {
      if (m.price > 0 && m.price <= hi + span * MARK_REACH && m.price >= lo - span * MARK_REACH) {
        hi = Math.max(hi, m.price);
        lo = Math.min(lo, m.price);
      }
    }
    if (hi === lo) return { hi: hi + 1, lo: lo - 1, maxVol };
    return { hi, lo, maxVol };
  }, [visible, marks, type]);

  const y = (p: number) => PAD_Y + ((hi - p) / (hi - lo)) * (priceH - PAD_Y * 2);
  const priceAt = (py: number) => hi - ((py - PAD_Y) / (priceH - PAD_Y * 2)) * (hi - lo);
  const cx = (i: number) => i * step + zoom / 2;

  // Gesture state lives in refs so the PanResponder is created once.
  const live = useRef({ step, offset: off, maxOffset, zoom, count: visible.length, plotW, plotH });
  live.current = { step, offset: off, maxOffset, zoom, count: visible.length, plotW, plotH };
  const gesture = useRef({ mode: 'idle' as 'idle' | 'pending' | 'scroll' | 'cross' | 'pinch', startOffset: 0, startZoom: 7, startDist: 1 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCb = useRef(onGestureActive);
  activeCb.current = onGestureActive;

  const pan = useMemo(() => {
    const setActive = (a: boolean) => activeCb.current?.(a);
    const clearTimer = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const point = (e: GestureResponderEvent) => ({
      x: clamp(e.nativeEvent.locationX, 0, live.current.plotW - 1),
      y: clamp(e.nativeEvent.locationY, 0, live.current.plotH),
    });
    const end = () => {
      clearTimer();
      if (gesture.current.mode === 'pending') setCross(null); // plain tap clears the crosshair
      gesture.current.mode = 'idle';
      setActive(false);
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => gesture.current.mode === 'idle' || gesture.current.mode === 'pending',
      onPanResponderGrant: (e) => {
        const g = gesture.current;
        g.mode = 'pending';
        g.startOffset = live.current.offset;
        g.startZoom = live.current.zoom;
        const p = point(e);
        clearTimer();
        timer.current = setTimeout(() => {
          if (g.mode !== 'pending') return;
          g.mode = 'cross';
          setActive(true);
          setCross(p);
          tap();
        }, LONG_PRESS_MS);
      },
      onPanResponderMove: (e, gs) => {
        const g = gesture.current;
        if (e.nativeEvent.touches.length >= 2) {
          if (g.mode !== 'pinch') {
            clearTimer();
            g.mode = 'pinch';
            g.startDist = touchDistance(e) || 1;
            g.startZoom = live.current.zoom;
            setCross(null);
            setActive(true);
          } else {
            setZoom(clamp(Math.round((g.startZoom * touchDistance(e)) / g.startDist), MIN_ZOOM, MAX_ZOOM));
          }
          return;
        }
        if (g.mode === 'pending' && Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy)) {
          clearTimer();
          g.mode = 'scroll';
          setCross(null);
          setActive(true);
        }
        if (g.mode === 'scroll') {
          setOffset(clamp(Math.round(g.startOffset + gs.dx / live.current.step), 0, live.current.maxOffset));
        } else if (g.mode === 'cross') {
          setCross(point(e));
        }
      },
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
    });
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Back to the latest candle when the series changes (new symbol / interval).
  const firstTime = candles[0]?.time;
  useEffect(() => {
    setOffset(0);
    setCross(null);
  }, [firstTime, intervalSec]);

  const last = visible[visible.length - 1];
  const crossIdx = cross ? clamp(Math.floor(cross.x / step), 0, visible.length - 1) : -1;
  const info = crossIdx >= 0 ? visible[crossIdx] : last;
  const axis = [0, 0.25, 0.5, 0.75, 1].map((t) => hi - (hi - lo) * t);
  const timeTicks = visible.length > 4 ? [0.15, 0.5, 0.85].map((t) => Math.floor(t * (visible.length - 1))) : [];

  const zoomBy = (d: number) => {
    tap();
    setZoom((z) => clamp(z + d, MIN_ZOOM, MAX_ZOOM));
  };

  return (
    <View>
      {/* Toolbar: chart type + zoom */}
      <View style={styles.toolbar}>
        <View style={styles.types}>
          {CHART_TYPES.map((t) => (
            <Pressable
              key={t.value}
              onPress={() => {
                tap();
                setType(t.value);
              }}
              style={[styles.typeBtn, type === t.value && styles.typeActive]}
            >
              <Text style={[styles.typeText, type === t.value && { color: colors.text }]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flex: 1 }} />
        {off > 0 && (
          <Pressable onPress={() => setOffset(0)} style={styles.iconBtn} hitSlop={6}>
            <Text style={styles.iconText}>⇥</Text>
          </Pressable>
        )}
        <Pressable onPress={() => zoomBy(-2)} style={styles.iconBtn} hitSlop={6}>
          <Text style={styles.iconText}>−</Text>
        </Pressable>
        <Pressable onPress={() => zoomBy(2)} style={styles.iconBtn} hitSlop={6}>
          <Text style={styles.iconText}>+</Text>
        </Pressable>
      </View>

      {/* OHLC readout (MT5 style) */}
      <Text style={styles.ohlc} numberOfLines={1}>
        {info ? (
          <>
            <Text style={styles.ohlcTime}>{fmtChartTime(info.time, intervalSec)}  </Text>
            O <Text style={styles.ohlcVal}>{fmt(info.open, priceScale)}</Text>  H{' '}
            <Text style={styles.ohlcVal}>{fmt(info.high, priceScale)}</Text>  L{' '}
            <Text style={styles.ohlcVal}>{fmt(info.low, priceScale)}</Text>  C{' '}
            <Text style={[styles.ohlcVal, { color: info.close >= info.open ? colors.long : colors.short }]}>
              {fmt(info.close, priceScale)}
            </Text>
          </>
        ) : (
          ' '
        )}
      </Text>

      <View style={[styles.box, { height }]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} {...pan.panHandlers}>
        <View style={StyleFill} pointerEvents="none">
          {width > 0 && visible.length > 0 && (
            <>
              {/* Grid + price axis (labels near the last-price tag are hidden) */}
              {axis.map((p) => (
                <View key={p} style={[styles.grid, { top: y(p), width: plotW }]}>
                  {(!last || Math.abs(y(p) - y(last.close)) > sz(14)) && (
                    <Text style={[styles.axisText, { left: plotW + 4 }]}>{fmt(p, priceScale)}</Text>
                  )}
                </View>
              ))}

              {/* Volume */}
              {visible.map((c, i) => (
                <VolumeBar
                  key={`v${c.time}`}
                  left={i * step}
                  width={zoom}
                  bottom={plotH}
                  height={maxVol > 0 ? (c.vol / maxVol) * plotH * VOL_H : 0}
                  up={c.close >= c.open}
                />
              ))}

              {/* Series: plain numbers as props, so only the candle that changed is redrawn */}
              {type === 'line'
                ? visible.slice(1).map((c, k) => (
                    <LineSegment key={c.time} x1={cx(k)} y1={y(visible[k].close)} x2={cx(k + 1)} y2={y(c.close)} />
                  ))
                : visible.map((c, i) => (
                    <CandleMark
                      key={c.time}
                      bar={type === 'bar'}
                      left={i * step}
                      width={zoom}
                      highY={y(c.high)}
                      lowY={y(c.low)}
                      openY={y(c.open)}
                      closeY={y(c.close)}
                      up={c.close >= c.open}
                    />
                  ))}

              {/* Time axis */}
              {timeTicks.map((i) => (
                <Text key={`t${i}`} style={[styles.timeText, { top: plotH + 2, left: clamp(cx(i) - sz(40), 0, plotW - sz(80)) }]}>
                  {fmtChartTime(visible[i].time, intervalSec)}
                </Text>
              ))}

              {/* Position lines */}
              {(() => {
                // Off-scale labels on the same edge stack instead of overlapping.
                const stack = { up: 0, down: 0 };
                return marks.filter((m) => m.price > 0).map((m) =>
                  m.price <= hi && m.price >= lo ? (
                    <View key={m.label} style={[styles.line, { top: y(m.price), width: plotW, borderColor: m.color }]}>
                      <Text style={[styles.lineLabel, { color: m.color }]}>{m.label}</Text>
                    </View>
                  ) : (
                    // Off-scale: a small arrow label on the edge it lies beyond.
                    <Text
                      key={m.label}
                      style={[
                        styles.edgeLabel,
                        { color: m.color },
                        m.price > hi
                          ? { top: sz(14) * stack.up++ }
                          : { top: priceH - sz(14) * ++stack.down },
                      ]}
                    >
                      {m.price > hi ? '▲' : '▼'} {m.label} {fmt(m.price, priceScale)}
                    </Text>
                  ),
                );
              })()}

              {/* Last price */}
              {last && off === 0 && (
                <View style={[styles.line, { top: y(last.close), width: plotW, borderColor: colors.text + '55' }]}>
                  <View style={[styles.tag, { left: plotW, backgroundColor: last.close >= last.open ? colors.long : colors.short }]}>
                    <Text style={styles.tagText}>{fmt(last.close, priceScale)}</Text>
                  </View>
                </View>
              )}

              {/* Crosshair */}
              {cross && crossIdx >= 0 && (
                <>
                  <View style={[styles.crossV, { left: cx(crossIdx), height: plotH }]} />
                  <View style={[styles.crossH, { top: cross.y, width: plotW }]}>
                    <View style={[styles.tag, { left: plotW, backgroundColor: colors.cardAlt }]}>
                      <Text style={styles.tagText}>{fmt(priceAt(cross.y), priceScale)}</Text>
                    </View>
                  </View>
                  <View style={[styles.timeTag, { top: plotH, left: clamp(cx(crossIdx) - sz(42), 0, plotW - sz(84)) }]}>
                    <Text style={styles.tagText}>{fmtChartTime(visible[crossIdx].time, intervalSec)}</Text>
                  </View>
                </>
              )}
            </>
          )}
        </View>
        {loading && visible.length === 0 && <ActivityIndicator color={colors.muted} style={StyleFill} />}
      </View>
    </View>
  );
});

const VolumeBar = memo(function VolumeBar({ left, width, bottom, height, up }: { left: number; width: number; bottom: number; height: number; up: boolean }) {
  return (
    <View style={{ position: 'absolute', left, top: bottom - height, width, height, backgroundColor: (up ? colors.long : colors.short) + '40' }} />
  );
});

const LineSegment = memo(function LineSegment({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  return (
    <View
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - len / 2,
        top: (y1 + y2) / 2 - 0.75,
        width: len,
        height: 1.5,
        backgroundColor: LINE_COLOR,
        transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
      }}
    />
  );
});

const CandleMark = memo(function CandleMark({
  bar,
  left,
  width,
  highY,
  lowY,
  openY,
  closeY,
  up,
}: {
  bar: boolean;
  left: number;
  width: number;
  highY: number;
  lowY: number;
  openY: number;
  closeY: number;
  up: boolean;
}) {
  const color = up ? colors.long : colors.short;
  const middle = left + width / 2;
  // OHLC bar: open tick left, close tick right.
  const tick = Math.max(width / 2, 2);
  return (
    <>
      <View style={{ position: 'absolute', left: middle - 0.5, top: highY, width: 1, height: Math.max(lowY - highY, 1), backgroundColor: color }} />
      {bar ? (
        <>
          <View style={{ position: 'absolute', left: middle - tick, top: openY, width: tick, height: 1, backgroundColor: color }} />
          <View style={{ position: 'absolute', left: middle, top: closeY, width: tick, height: 1, backgroundColor: color }} />
        </>
      ) : (
        <View style={{ position: 'absolute', left, top: Math.min(openY, closeY), width, height: Math.max(Math.abs(openY - closeY), 1), backgroundColor: color }} />
      )}
    </>
  );
});

const StyleFill = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;

const styles = createStyles({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  types: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: 6, padding: 2 },
  typeBtn: { paddingHorizontal: 10, height: 26, borderRadius: 5, justifyContent: 'center' },
  typeActive: { backgroundColor: colors.cardAlt },
  typeText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  iconBtn: {
    width: 30,
    height: 26,
    borderRadius: 6,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  ohlc: { color: colors.muted, fontSize: 10.5, marginBottom: 2, fontVariant: ['tabular-nums'] },
  ohlcTime: { color: colors.text },
  ohlcVal: { color: colors.text },
  box: { overflow: 'hidden' },
  grid: { position: 'absolute', left: 0, height: 1, backgroundColor: colors.border },
  axisText: { position: 'absolute', top: -7, color: colors.muted, fontSize: 10, fontVariant: ['tabular-nums'] },
  timeText: { position: 'absolute', width: 80, textAlign: 'center', color: colors.muted, fontSize: 9.5 },
  line: { position: 'absolute', left: 0, height: 0, borderTopWidth: 1, borderStyle: 'dashed' },
  lineLabel: { position: 'absolute', left: 2, top: -14, fontSize: 9, fontWeight: '700' },
  edgeLabel: { position: 'absolute', left: 4, fontSize: 9, fontWeight: '700', lineHeight: 14 },
  tag: { position: 'absolute', top: -9, paddingHorizontal: 4, height: 18, borderRadius: 3, justifyContent: 'center' },
  tagText: { color: colors.text, fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
  crossV: { position: 'absolute', top: 0, width: 0, borderLeftWidth: 1, borderStyle: 'dashed', borderColor: colors.muted },
  crossH: { position: 'absolute', left: 0, height: 0, borderTopWidth: 1, borderStyle: 'dashed', borderColor: colors.muted },
  timeTag: {
    position: 'absolute',
    width: 84,
    height: 16,
    borderRadius: 3,
    backgroundColor: colors.sheet,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
