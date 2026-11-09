import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { StreamStatus as SocketStatus } from '../exchanges';
import { createStyles, colors } from '../theme';
import { ExchangePill } from './ExchangeSwitch';

const STATUS: Record<SocketStatus, { color: string; label: string }> = {
  open: { color: colors.long, label: 'Live' },
  connecting: { color: colors.warn, label: 'Đang nối' },
  closed: { color: colors.short, label: 'Polling' },
};

export function Header({ title, ws, right }: { title: string; ws?: SocketStatus; right?: ReactNode }) {
  return (
    <View style={styles.bar}>
      <Text style={styles.title}>{title}</Text>
      <ExchangePill />
      {ws && (
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: STATUS[ws].color }]} />
          <Text style={styles.statusText}>{STATUS[ws].label}</Text>
        </View>
      )}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

const styles = createStyles({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: 48 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: colors.card,
  },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 5 },
  statusText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
});
