import { createContext, useContext, useState, type ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { EXCHANGES, type ExchangeId } from '../exchanges';
import { tap } from '../haptics';
import { loadCredentialsFor, savedExchanges, setActiveExchange, type Credentials } from '../storage/credentials';
import { createStyles, colors } from '../theme';

interface Ctx {
  current: ExchangeId;
  open: () => void;
}

const ExchangeCtx = createContext<Ctx | null>(null);

/** Quick switch between exchanges that have a saved key; the pill lives in every screen header. */
export function ExchangeSwitchProvider({
  current,
  onSwitch,
  onAddKey,
  children,
}: {
  current: ExchangeId;
  onSwitch: (c: Credentials) => void;
  onAddKey: () => void;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState<ExchangeId[]>([]);

  const open = () => {
    tap();
    savedExchanges().then(setSaved).catch(() => {});
    setVisible(true);
  };

  const pick = async (id: ExchangeId) => {
    if (id === current) return setVisible(false);
    if (!saved.includes(id)) {
      setVisible(false);
      return onAddKey();
    }
    const c = await loadCredentialsFor(id);
    if (!c) return;
    await setActiveExchange(id);
    tap();
    setVisible(false);
    onSwitch(c);
  };

  return (
    <ExchangeCtx.Provider value={{ current, open }}>
      {children}
      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <Pressable style={styles.backdrop} onPress={() => setVisible(false)}>
          <View style={styles.sheet}>
            <Text style={styles.title}>Chọn sàn giao dịch</Text>
            {EXCHANGES.map((e) => {
              const on = e.id === current;
              const has = saved.includes(e.id) || on;
              return (
                <Pressable
                  key={e.id}
                  onPress={() => pick(e.id)}
                  style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && { opacity: 0.6 }]}
                >
                  <View style={[styles.dot, { backgroundColor: on ? colors.long : has ? colors.muted : 'transparent' }]} />
                  <Text style={[styles.name, !has && { color: colors.muted }]}>{e.name}</Text>
                  <Text style={styles.state}>{on ? 'Đang dùng' : has ? 'Chuyển' : '+ Thêm key'}</Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </ExchangeCtx.Provider>
  );
}

/** "MEXC ▾" pill; renders nothing outside the provider (first-run setup). */
export function ExchangePill() {
  const ctx = useContext(ExchangeCtx);
  if (!ctx) return null;
  const name = EXCHANGES.find((e) => e.id === ctx.current)?.name ?? ctx.current;
  return (
    <Pressable onPress={ctx.open} hitSlop={6} style={({ pressed }) => [styles.pill, pressed && { opacity: 0.6 }]}>
      <Text style={styles.pillText}>{name}</Text>
      <Text style={styles.caret}>▾</Text>
    </Pressable>
  );
}

const styles = createStyles({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 8,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.warn + '88',
    backgroundColor: colors.warn + '14',
  },
  pillText: { color: colors.warn, fontSize: 12, fontWeight: '800' },
  caret: { color: colors.warn, fontSize: 10 },
  backdrop: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 28 },
  sheet: { backgroundColor: colors.sheet, borderRadius: 14, padding: 14, gap: 6 },
  title: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, height: 48, borderRadius: 10, backgroundColor: colors.bg },
  rowOn: { borderWidth: 1, borderColor: colors.warn },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.muted },
  name: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
  state: { color: colors.muted, fontSize: 12, fontWeight: '600' },
});
