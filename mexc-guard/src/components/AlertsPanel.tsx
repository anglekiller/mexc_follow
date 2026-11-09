import { useState } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { clearAlertLog, type AlertEntry, type AlertLevel } from '../alerts/log';
import type { Alerts } from '../alerts/useAlerts';
import { createStyles, colors, fmtTime } from '../theme';

const LEVEL_COLOR: Record<AlertLevel, string> = { critical: colors.short, warn: colors.warn, info: colors.accent };
const RECENT_MS = 6 * 60 * 60_000;

function Entry({ a, full }: { a: AlertEntry; full?: boolean }) {
  return (
    <View style={[styles.entry, { borderLeftColor: LEVEL_COLOR[a.level] }]}>
      <View style={styles.entryHead}>
        <Text style={styles.title} numberOfLines={full ? undefined : 1}>
          {a.title}
        </Text>
        <Text style={styles.time}>{fmtTime(a.time).slice(0, 5)}</Text>
      </View>
      {a.ai ? (
        <Text style={styles.ai} numberOfLines={full ? undefined : 3}>
          <Text style={styles.aiTag}>AI  </Text>
          {a.ai}
        </Text>
      ) : null}
      {(full || !a.ai) && <Text style={styles.detail}>{a.detail}</Text>}
      {full && <Text style={styles.time}>{fmtTime(a.time)}</Text>}
    </View>
  );
}

/** Latest reminders on top of the portfolio, with the full history in a sheet. */
export function AlertsPanel({ alerts }: { alerts: Alerts }) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const recent = alerts.log.filter((a) => Date.now() - a.time < RECENT_MS).slice(0, 2);
  if (!alerts.log.length) return null;

  return (
    <View style={styles.panel}>
      <Pressable onPress={() => setOpen(true)} style={styles.header}>
        <Text style={styles.heading}>🤖 AI nhắc nhở</Text>
        <Text style={styles.more}>Tất cả ({alerts.log.length}) ›</Text>
      </Pressable>
      {recent.length ? (
        recent.map((a) => <Entry key={a.id} a={a} />)
      ) : (
        <Text style={styles.detail}>Không có nhắc nhở mới trong 6 giờ qua.</Text>
      )}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.sheet, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>AI nhắc nhở</Text>
            <Pressable
              onPress={async () => {
                await clearAlertLog();
                alerts.reload();
                setOpen(false);
              }}
              hitSlop={10}
            >
              <Text style={[styles.more, { color: colors.short }]}>Xóa hết</Text>
            </Pressable>
            <Pressable onPress={() => setOpen(false)} hitSlop={10} style={{ marginLeft: 20 }}>
              <Text style={[styles.more, { color: colors.warn }]}>Đóng</Text>
            </Pressable>
          </View>
          <FlatList
            data={alerts.log}
            keyExtractor={(a) => a.id}
            renderItem={({ item }) => <Entry a={item} full />}
            contentContainerStyle={{ padding: 16 }}
          />
          <Text style={styles.disclaimer}>Gợi ý do AI tạo tự động, chỉ để tham khảo — không phải lời khuyên tài chính.</Text>
        </View>
      </Modal>
    </View>
  );
}

const styles = createStyles({
  panel: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  heading: { color: colors.text, fontSize: 14, fontWeight: '700' },
  more: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  entry: { borderLeftWidth: 3, paddingLeft: 8, marginTop: 8 },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '700' },
  time: { color: colors.muted, fontSize: 11 },
  ai: { color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 4 },
  aiTag: { color: colors.accent, fontWeight: '800', fontSize: 11 },
  detail: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  sheet: { flex: 1, backgroundColor: colors.bg },
  sheetHead: { flexDirection: 'row', alignItems: 'center', padding: 16, paddingBottom: 4 },
  sheetTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '800' },
  disclaimer: { color: colors.muted, fontSize: 11, textAlign: 'center', padding: 12 },
});
