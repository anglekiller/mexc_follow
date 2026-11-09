import { memo, startTransition, useEffect, useRef, useState } from 'react';
import { Animated, Text, View, type ImageSourcePropType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ExchangeSwitchProvider } from '../components/ExchangeSwitch';
import { SlidingSelector } from '../components/SlidingSelector';
import { useFutures } from '../hooks/useFutures';
import type { Credentials } from '../storage/credentials';
import { createStyles, colors, sz, useGlass } from '../theme';
import { useWidgetSync } from '../widget/useWidgetSync';
import { useAlerts } from '../alerts/useAlerts';
import { HistoryScreen } from './HistoryScreen';
import { NewsScreen } from './NewsScreen';
import { PortfolioScreen } from './PortfolioScreen';
import { SettingsScreen } from './SettingsScreen';
import { SignalsScreen } from './SignalsScreen';
import { TradeScreen, type TradePreset } from './TradeScreen';

// Takes no live data, so price ticks must not redraw it.
const Settings = memo(SettingsScreen);

type Tab = 'portfolio' | 'signals' | 'trade' | 'history' | 'news' | 'settings';

const TABS: { key: Tab; label: string; icon: ImageSourcePropType }[] = [
  { key: 'portfolio', label: 'Danh mục', icon: require('../../assets/tabs/portfolio.png') },
  { key: 'signals', label: 'Tín hiệu', icon: require('../../assets/tabs/signals.png') },
  { key: 'trade', label: 'Giao dịch', icon: require('../../assets/tabs/trade.png') },
  { key: 'history', label: 'Lịch sử', icon: require('../../assets/tabs/history.png') },
  { key: 'news', label: 'Tin tức', icon: require('../../assets/tabs/news.png') },
  { key: 'settings', label: 'Cài đặt', icon: require('../../assets/tabs/settings.png') },
];

/** Lets the highlight finish most of its slide before the next screen is built. */
const TAB_SWITCH_DELAY_MS = 170;

/** Scaled rather than resized, so the active icon never shifts the layout mid-animation. */
function TabIcon({ source, color, enlarged }: { source: ImageSourcePropType; color: string; enlarged: boolean }) {
  const scale = useRef(new Animated.Value(enlarged ? 1.2 : 1)).current;
  useEffect(() => {
    Animated.spring(scale, { toValue: enlarged ? 1.2 : 1, damping: 26, stiffness: 300, useNativeDriver: true }).start();
  }, [enlarged, scale]);
  const size = sz(22);
  return <Animated.Image source={source} style={{ width: size, height: size, tintColor: color, transform: [{ scale }] }} />;
}

interface Props {
  creds: Credentials;
  onCredsChange: (c: Credentials | null) => void;
}

export function MainScreen({ creds, onCredsChange }: Props) {
  const insets = useSafeAreaInsets();
  const glass = useGlass();
  // One data source shared by all tabs, so switching tabs does not refetch.
  const f = useFutures(creds);
  useWidgetSync(f);
  const alerts = useAlerts(f);
  const [tab, setTab] = useState<Tab>('portfolio');
  // Order plan from the signals tab, consumed by the trade tab when it opens.
  const [tradePreset, setTradePreset] = useState<TradePreset | null>(null);

  return (
    <ExchangeSwitchProvider current={creds.exchange} onSwitch={onCredsChange} onAddKey={() => setTab('settings')}>
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={{ flex: 1 }}>
        {tab === 'portfolio' && (
          <PortfolioScreen f={f} alerts={alerts} creds={creds} onOpenSettings={() => setTab('settings')} />
        )}
        {tab === 'signals' && (
          <SignalsScreen
            key={creds.exchange}
            f={f}
            onPlan={(p) => {
              setTradePreset(p);
              setTab('trade');
            }}
          />
        )}
        {tab === 'trade' && (
          <TradeScreen key={creds.exchange} f={f} preset={tradePreset} onPresetUsed={() => setTradePreset(null)} />
        )}
        {tab === 'history' && <HistoryScreen key={creds.exchange} f={f} />}
        {tab === 'news' && <NewsScreen f={f} />}
        {tab === 'settings' && <Settings key={creds.exchange} creds={creds} onSaved={onCredsChange} />}
      </View>

      <View style={glass ? [styles.tabBarGlass, { marginBottom: insets.bottom + sz(8) }] : [styles.tabBar, { paddingBottom: insets.bottom }]}>
        <SlidingSelector
          options={TABS}
          value={TABS.find((t) => t.key === tab)!}
          onChange={(t) => startTransition(() => setTab(t.key))}
          changeDelayMs={TAB_SWITCH_DELAY_MS}
          itemStyle={styles.tabItem}
          pillStyle={styles.tabPill}
          lensStyle={styles.tabLens}
          renderItem={(t, active) => {
            const badge = t.key === 'portfolio' && f.positions.length > 0 ? f.positions.length : null;
            const color = active ? (glass ? '#4A9BFF' : colors.text) : glass ? colors.text : colors.muted;
            return (
              <>
                <TabIcon source={t.icon} color={color} enlarged={glass && active} />
                <Text style={[styles.tabText, active && styles.tabTextActive, { color }]} numberOfLines={1} adjustsFontSizeToFit>
                  {t.label}
                  {badge !== null && <Text style={styles.badge}> {badge}</Text>}
                </Text>
              </>
            );
          }}
        />
      </View>
    </View>
    </ExchangeSwitchProvider>
  );
}

const styles = createStyles({
  screen: { flex: 1, backgroundColor: colors.page },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  tabBarGlass: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(58,58,62,0.78)',
  },
  // At rest the lens is exactly as tall as the bar; it only swells while moving.
  tabLens: { marginVertical: 3, marginHorizontal: -6 },
  tabItem: { height: 60, alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 6 },
  tabPill: { marginVertical: 7, marginHorizontal: 3, borderRadius: 14, backgroundColor: colors.cardAlt },
  tabText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  tabTextActive: { color: colors.text, fontWeight: '700' },
  badge: { color: colors.warn, fontWeight: '800' },
});
