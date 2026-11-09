import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Animated, Image, PanResponder, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { menuTap } from '../haptics';
import { useGlass } from '../theme';

interface Props<T> {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  renderItem: (option: T, active: boolean) => ReactNode;
  itemStyle?: StyleProp<ViewStyle>;
  /** Look of the highlight that slides between the options. */
  pillStyle?: StyleProp<ViewStyle>;
  /** Glass mode draws the highlight as a shiny droplet; turn off for non-pill highlights. */
  gloss?: boolean;
  /** Glass mode only: draw the highlight as a lens with this layout (it may overflow the row). */
  lensStyle?: StyleProp<ViewStyle>;
  /** Delay before onChange, for options that mount a heavy screen: the highlight moves first. */
  changeDelayMs?: number;
}

/** How much the lens swells while it is moving or dragged. */
const DRAG_LENS_LIFT = 1.26;

const DROPLET: ViewStyle = {
  borderRadius: 999,
  borderWidth: StyleSheet.hairlineWidth * 2,
  backgroundColor: 'rgba(255,255,255,0.20)',
  borderTopColor: 'rgba(255,255,255,0.42)',
  borderLeftColor: 'rgba(255,255,255,0.24)',
  borderRightColor: 'rgba(255,255,255,0.24)',
  borderBottomColor: 'rgba(255,255,255,0.16)',
};

/**
 * Equal-width options with a springy highlight. Tap an option, or drag a finger across them:
 * the highlight follows and the option under the finger is chosen on release.
 */
export function SlidingSelector<T>({ options, value, onChange, renderItem, itemStyle, pillStyle, gloss = true, lensStyle, changeDelayMs = 0 }: Props<T>) {
  const glass = useGlass();
  const shiny = glass && gloss;
  const isLens = shiny && !!lensStyle;
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const x = useRef(new Animated.Value(0)).current;
  const stretch = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(1)).current;
  const shinyRef = useRef(shiny);
  shinyRef.current = shiny;
  // Keeps the droplet's area constant: wider while moving means slightly flatter.
  const squash = useRef(stretch.interpolate({ inputRange: [1, 1.14], outputRange: [1, 0.92] })).current;
  // The lens is a dark capsule at rest and turns into glass as it swells.
  const lensOpacity = useRef(lift.interpolate({ inputRange: [1, 1.1], outputRange: [0, 1], extrapolate: 'clamp' })).current;
  const restOpacity = useRef(lift.interpolate({ inputRange: [1, 1.1], outputRange: [1, 0], extrapolate: 'clamp' })).current;

  const liftTo = (toValue: number) => {
    if (shinyRef.current) Animated.spring(lift, { toValue, damping: 22, stiffness: 320, useNativeDriver: true }).start();
  };
  const row = useRef<ComponentRef<typeof View>>(null);
  const placed = useRef(false);

  const index = Math.max(options.indexOf(value), 0);
  // Chosen, but onChange has not fired yet (changeDelayMs).
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => setPending(null), [index]);
  const target = hover ?? pending ?? index;

  // Read from the gesture handlers, which are created only once.
  const latest = useRef({ options, onChange, index, width, changeDelayMs, left: 0, hover: null as number | null });
  Object.assign(latest.current, { options, onChange, index, width, changeDelayMs });

  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (changeTimer.current && clearTimeout(changeTimer.current)), []);
  const commit = useRef((i: number) => {
    if (changeTimer.current) clearTimeout(changeTimer.current);
    const fire = () => latest.current.onChange(latest.current.options[i]);
    if (!latest.current.changeDelayMs) return fire();
    setPending(i);
    changeTimer.current = setTimeout(fire, latest.current.changeDelayMs);
  }).current;

  useEffect(() => {
    if (!width) return;
    const toValue = (target * width) / options.length;
    if (!placed.current) {
      placed.current = true;
      x.setValue(toValue);
      return;
    }
    Animated.spring(x, { toValue, damping: 26, stiffness: 300, useNativeDriver: true }).start();
    if (shinyRef.current) {
      // Stretches as it leaves, settles back without wobbling.
      Animated.sequence([
        Animated.timing(stretch, { toValue: 1.14, duration: 110, useNativeDriver: true }),
        Animated.spring(stretch, { toValue: 1, damping: 24, stiffness: 240, useNativeDriver: true }),
      ]).start();
      if (isLens) {
        Animated.sequence([
          Animated.timing(lift, { toValue: DRAG_LENS_LIFT, duration: 110, useNativeDriver: true }),
          Animated.spring(lift, { toValue: dragging ? DRAG_LENS_LIFT : 1, damping: 22, stiffness: 240, useNativeDriver: true }),
        ]).start();
      }
    }
  }, [target, width, options.length, x, stretch]);

  // The droplet swells while a finger drags it.
  const dragging = hover !== null;
  useEffect(() => {
    liftTo(dragging ? (isLens ? DRAG_LENS_LIFT : 1.1) : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const setHovered = (next: number | null) => {
    if (next === latest.current.hover) return;
    if (next !== null) menuTap();
    latest.current.hover = next;
    setHover(next);
  };

  const pan = useRef(
    PanResponder.create({
      // Only horizontal drags: vertical ones still scroll the page.
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        const { width: w, left, options: opts } = latest.current;
        if (!w) return;
        const i = Math.floor(((g.moveX - left) / w) * opts.length);
        setHovered(Math.min(Math.max(i, 0), opts.length - 1));
      },
      onPanResponderRelease: () => {
        const { hover: chosen, index: current } = latest.current;
        latest.current.hover = null;
        setHover(null);
        if (chosen !== null && chosen !== current) commit(chosen);
      },
      onPanResponderTerminate: () => {
        latest.current.hover = null;
        setHover(null);
      },
    }),
  ).current;

  return (
    <View
      ref={row}
      style={{ flex: 1, flexDirection: 'row' }}
      onLayout={(e) => {
        setWidth(e.nativeEvent.layout.width);
        row.current?.measureInWindow((left) => {
          latest.current.left = left;
        });
      }}
      {...pan.panHandlers}
    >
      {width > 0 && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: width / options.length,
            transform: [{ translateX: x }, { scale: lift }, { scaleX: stretch }, { scaleY: squash }],
          }}
        >
          {shiny && lensStyle ? (
            <View style={[{ flex: 1 }, lensStyle]}>
              <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.72)', opacity: restOpacity }]} />
              <Animated.Image
                source={require('../../assets/glass-lens.png')}
                resizeMode="stretch"
                style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', opacity: lensOpacity }}
              />
            </View>
          ) : (
            <View style={[{ flex: 1 }, pillStyle, shiny && DROPLET]} />
          )}
        </Animated.View>
      )}
      {options.map((o, i) => (
        <Pressable
          key={i}
          accessibilityRole="tab"
          accessibilityState={{ selected: i === index }}
          onPressIn={() => liftTo(isLens ? 1.12 : 1.06)}
          onPressOut={() => liftTo(1)}
          onPress={() => {
            if (i === target) return;
            menuTap();
            commit(i);
          }}
          style={[{ flex: 1 }, itemStyle]}
        >
          {renderItem(o, i === target)}
        </Pressable>
      ))}
    </View>
  );
}
