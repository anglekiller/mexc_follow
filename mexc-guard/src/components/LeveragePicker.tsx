import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, PanResponder, Pressable, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';

import { tap } from '../haptics';
import { createStyles, colors } from '../theme';

const PRESETS = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 500, 750, 1000];

interface Props {
  visible: boolean;
  value: number;
  min: number;
  max: number;
  /** Extra line under the value for the leverage being chosen, e.g. estimated liquidation. */
  describe?: (leverage: number) => string | null;
  onConfirm: (leverage: number) => void;
  onClose: () => void;
}

/** Bottom sheet with a slider, ± buttons, presets and free input for the order leverage. */
export function LeveragePicker({ visible, value, min, max, describe, onConfirm, onClose }: Props) {
  const [lev, setLev] = useState(value);
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (visible) {
      setLev(value);
      setText(String(value));
    }
  }, [visible, value]);

  const clamp = (n: number) => Math.min(Math.max(Math.round(n), min), max);
  const set = (n: number) => {
    const v = clamp(n);
    setLev(v);
    setText(String(v));
  };

  // Log scale when the range is wide (e.g. 1–1000x), so low leverage is not squeezed to the edge.
  const log = max / Math.max(min, 1) > 150;
  const toT = (v: number) =>
    max === min ? 0 : log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  const fromT = (t: number) => (log ? min * Math.pow(max / min, t) : min + t * (max - min));

  const width = useRef(1);
  const startT = useRef(0);
  const latest = useRef({ lev, min, max, log });
  latest.current = { lev, min, max, log };
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          startT.current = e.nativeEvent.locationX / width.current;
          setFromT(startT.current);
        },
        onPanResponderMove: (_, g) => setFromT(startT.current + g.dx / width.current),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  function setFromT(t: number) {
    const { min: lo, max: hi, log: lg } = latest.current;
    const c = Math.min(Math.max(t, 0), 1);
    const v = Math.min(Math.max(Math.round(lg ? lo * Math.pow(hi / lo, c) : lo + c * (hi - lo)), lo), hi);
    if (v !== latest.current.lev) {
      setLev(v);
      setText(String(v));
    }
  }

  const presets = [...new Set([...PRESETS.filter((p) => p >= min && p < max), max])];
  const t = toT(lev);
  const note = describe?.(lev);
  const risky = lev >= 50;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.title}>Đòn bẩy</Text>

        <View style={styles.valueRow}>
          <Pressable onPress={() => (tap(), set(lev - 1))} style={styles.step}>
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <View style={styles.inputWrap}>
            <TextInput
              value={text}
              onChangeText={(s) => {
                const d = s.replace(/[^0-9]/g, '');
                setText(d);
                const n = parseInt(d, 10);
                if (n >= min && n <= max) setLev(n);
              }}
              onBlur={() => set(parseInt(text, 10) || lev)}
              keyboardType="number-pad"
              style={[styles.input, risky && { color: colors.warn }]}
              selectTextOnFocus
            />
            <Text style={[styles.x, risky && { color: colors.warn }]}>x</Text>
          </View>
          <Pressable onPress={() => (tap(), set(lev + 1))} style={styles.step}>
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>

        {/* Slider */}
        <View
          style={styles.track}
          onLayout={(e: LayoutChangeEvent) => (width.current = Math.max(e.nativeEvent.layout.width, 1))}
          {...pan.panHandlers}
        >
          <View style={styles.rail} pointerEvents="none">
            <View style={[styles.fill, { width: `${t * 100}%` }, risky && { backgroundColor: colors.warn }]} />
          </View>
          <View style={[styles.thumb, { left: `${t * 100}%` }]} pointerEvents="none" />
        </View>
        <View style={styles.scale}>
          <Text style={styles.muted}>{min}x</Text>
          {log && <Text style={styles.muted}>{Math.round(fromT(0.5))}x</Text>}
          <Text style={styles.muted}>{max}x</Text>
        </View>

        <View style={styles.presets}>
          {presets.map((p) => (
            <Pressable
              key={p}
              onPress={() => (tap(), set(p))}
              style={[styles.preset, lev === p && styles.presetActive]}
            >
              <Text style={[styles.presetText, lev === p && { color: colors.text }]}>{p}x</Text>
            </Pressable>
          ))}
        </View>

        {note && <Text style={styles.note}>{note}</Text>}
        {risky && <Text style={styles.warn}>Đòn bẩy cao: biến động nhỏ cũng có thể bị thanh lý.</Text>}

        <Pressable
          onPress={() => {
            tap();
            onConfirm(clamp(parseInt(text, 10) || lev));
          }}
          style={({ pressed }) => [styles.confirm, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.confirmText}>Xác nhận {lev}x</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const THUMB = 24;

const styles = createStyles({
  backdrop: { flex: 1, backgroundColor: '#000000AA' },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { color: colors.text, fontSize: 24, fontWeight: '600' },
  inputWrap: {
    flex: 1,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: { color: colors.text, fontSize: 24, fontWeight: '800', textAlign: 'right', minWidth: 40, padding: 0 },
  x: { color: colors.text, fontSize: 24, fontWeight: '800' },
  track: { height: 44, justifyContent: 'center', marginTop: 12, marginHorizontal: THUMB / 2 },
  rail: { height: 6, borderRadius: 3, backgroundColor: colors.cardAlt, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: colors.accent },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    marginLeft: -THUMB / 2,
    borderRadius: THUMB / 2,
    backgroundColor: colors.text,
  },
  scale: { flexDirection: 'row', justifyContent: 'space-between' },
  muted: { color: colors.muted, fontSize: 11 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  preset: {
    paddingHorizontal: 10,
    height: 30,
    borderRadius: 6,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  presetActive: { borderColor: colors.warn, backgroundColor: colors.warn + '1F' },
  presetText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  note: { color: colors.text, fontSize: 13, marginTop: 14 },
  warn: { color: colors.warn, fontSize: 12, marginTop: 6 },
  confirm: {
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.warn,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  confirmText: { color: colors.bg, fontSize: 16, fontWeight: '800' },
});
