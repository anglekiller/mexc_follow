import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Linking, Platform, Pressable, RefreshControl, Text, View } from 'react-native';

import { FEEDS, fetchCalendar, fetchFeed, type CalendarEvent, type Impact, type NewsItem } from '../api/news';
import type { Ticker } from '../api/types';
import { cachedNewsTranslations, translateNews, type NewsTranslation } from '../api/translate';
import { ArticleViewer } from '../components/ArticleViewer';
import { Header } from '../components/Header';
import { SlidingSelector } from '../components/SlidingSelector';
import { tap } from '../haptics';
import type { Futures } from '../hooks/useFutures';
import { createStyles, colors, fmt, sz, useGlass } from '../theme';

const CALENDAR = 'calendar';
const FEED_TTL = 2 * 60_000;
const AUTO_REFRESH_MS = 3 * 60_000;

type TabKey = string;
const TABS: { key: TabKey; label: string }[] = [
  ...FEEDS.map((f) => ({ key: f.key, label: f.label })),
  { key: CALENDAR, label: 'Lịch KT' },
];

// Survives tab switches (the screen unmounts), so coming back is instant.
const feedCache = new Map<string, { at: number; items: NewsItem[] }>();

const p2 = (n: number) => String(n).padStart(2, '0');

function ago(ms: number) {
  if (!ms) return '';
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return 'vừa xong';
  if (min < 60) return `${min} phút trước`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = new Date(ms);
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
}

function countdown(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} phút nữa`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h${p2(min % 60)} nữa` : `${Math.floor(h / 24)} ngày nữa`;
}

const WEEKDAY = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

const IMPACT: Record<Impact, { color: string; label: string }> = {
  High: { color: colors.short, label: 'Cao' },
  Medium: { color: '#F7931A', label: 'TB' },
  Low: { color: colors.warn, label: 'Thấp' },
  Holiday: { color: colors.muted, label: 'Nghỉ' },
};

/** Desktop build: no in-app reader, articles open in the system browser. */
const openInBrowser = (n: NewsItem) => void Linking.openURL(n.link).catch(() => {});

export function NewsScreen({ f }: { f: Futures }) {
  const [tab, setTab] = useState<TabKey>(FEEDS[0].key);
  const gold = useGoldTicker(f);
  const [reading, setReading] = useState<NewsItem | null>(null);
  const glass = useGlass();

  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Tin tức"
        right={
          gold && (
            <View style={styles.gold}>
              <Text style={styles.goldLabel}>{gold.name}</Text>
              <Text style={styles.goldPrice}>{fmt(gold.price, 2)}</Text>
              <Text style={[styles.goldChange, { color: gold.change >= 0 ? colors.long : colors.short }]}>
                {gold.change >= 0 ? '+' : ''}
                {(gold.change * 100).toFixed(2)}%
              </Text>
            </View>
          )
        }
      />

      <View style={[styles.tabs, glass && { borderRadius: 999 }]}>
        <SlidingSelector
          options={TABS}
          value={TABS.find((t) => t.key === tab)!}
          onChange={(t) => setTab(t.key)}
          itemStyle={styles.tab}
          pillStyle={styles.tabActive}
          renderItem={(t, active) => (
            <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
              {t.label}
            </Text>
          )}
        />
      </View>

      {tab === CALENDAR ? <CalendarList /> : <FeedList key={tab} feedKey={tab} onOpen={Platform.OS === 'web' ? openInBrowser : setReading} />}
      <ArticleViewer item={reading} onClose={() => setReading(null)} />
    </View>
  );
}

/** Gold price for the header: the live stream if the app already follows XAU, else a light REST poll. */
function useGoldTicker(f: Futures) {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  useEffect(() => {
    if (!f.api) return;
    const api = f.api;
    let alive = true;
    const load = () =>
      api
        .getTicker(api.goldSymbol)
        .then((t) => alive && setTicker(t))
        .catch(() => {});
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [f.api]);
  if (!ticker) return null;
  const v = ticker.riseFallValue;
  const change = v !== undefined && ticker.lastPrice - v > 0 ? v / (ticker.lastPrice - v) : ticker.riseFallRate;
  return { name: f.api ? f.api.baseOf(f.api.goldSymbol) : 'XAU', price: (f.api && f.marks[f.api.goldSymbol]) ?? ticker.lastPrice, change };
}

// ---------- News ----------

// memo: the parent re-renders with every price tick (gold in the header); the lists don't need to.
const FeedList = memo(FeedListView);

function FeedListView({ feedKey, onOpen }: { feedKey: string; onOpen: (n: NewsItem) => void }) {
  const feed = FEEDS.find((x) => x.key === feedKey)!;
  const cached = feedCache.get(feedKey);
  const [items, setItems] = useState<NewsItem[]>(cached?.items ?? []);
  const [loading, setLoading] = useState(!cached);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      const c = feedCache.get(feedKey);
      if (!force && c && Date.now() - c.at < FEED_TTL) return;
      try {
        const next = await fetchFeed(feed);
        feedCache.set(feedKey, { at: Date.now(), items: next });
        setItems(next);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Lỗi tải tin');
      } finally {
        setLoading(false);
      }
    },
    [feed, feedKey],
  );

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const [translated, setTranslated] = useState<Record<string, NewsTranslation>>({});
  const [translateNote, setTranslateNote] = useState<string | null>(null);
  useEffect(() => {
    if (!feed.lang || !items.length) return;
    let alive = true;
    const show = () => alive && setTranslated(cachedNewsTranslations(items));
    show();
    translateNews(items, show, () => alive)
      .then(() => alive && setTranslateNote(null))
      .catch((e) => alive && setTranslateNote(e instanceof Error ? e.message : 'Lỗi dịch'));
    return () => {
      alive = false;
    };
  }, [feed.lang, items]);

  const shown = useMemo(
    () =>
      items.map((n) => {
        const vi = translated[n.id];
        return vi ? { ...n, title: vi.title, summary: vi.summary ?? n.summary } : n;
      }),
    [items, translated],
  );

  if (loading) return <ActivityIndicator color={colors.muted} style={{ marginTop: sz(40) }} />;

  return (
    <FlatList
      data={shown}
      keyExtractor={(n) => n.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} colors={[colors.warn]} progressBackgroundColor={colors.card} />}
      ListHeaderComponent={
        error || translateNote ? (
          <>
            {error && <Text style={styles.error}>Không tải được tin: {error}</Text>}
            {translateNote && <Text style={styles.hint}>Chưa dịch được: {translateNote}</Text>}
          </>
        ) : undefined
      }
      ListEmptyComponent={!error ? <Text style={styles.empty}>Chưa có tin.</Text> : undefined}
      renderItem={({ item }) => <NewsRow item={item} onOpen={onOpen} />}
      initialNumToRender={12}
      windowSize={7}
    />
  );
}

const NewsRow = memo(NewsRowView);

function NewsRowView({ item, onOpen }: { item: NewsItem; onOpen: (n: NewsItem) => void }) {
  const fresh = item.time > 0 && Date.now() - item.time < 60 * 60_000;
  return (
    <Pressable
      onPress={() => {
        tap();
        onOpen(item);
      }}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={3}>
          {item.title}
        </Text>
        {item.summary ? (
          <Text style={styles.summary} numberOfLines={2}>
            {item.summary}
          </Text>
        ) : undefined}
        <View style={styles.meta}>
          {fresh && <Text style={styles.newBadge}>MỚI</Text>}
          <Text style={styles.metaText} numberOfLines={1}>
            {[item.source, ago(item.time)].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </View>
      {item.image ? <Image source={{ uri: item.image }} resizeMethod="resize" style={styles.thumb} /> : undefined}
    </Pressable>
  );
}

// ---------- Economic calendar ----------

type Row = { type: 'day'; key: string; label: string } | { type: 'event'; key: string; e: CalendarEvent };

const CalendarList = memo(CalendarListView);

function CalendarListView() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usdOnly, setUsdOnly] = useState(true);
  const [importantOnly, setImportantOnly] = useState(true);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setEvents(await fetchCalendar());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi tải lịch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Keeps countdowns and the "next event" highlight current.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const shown = useMemo(
    () =>
      events.filter(
        (e) =>
          (!usdOnly || e.country === 'USD') &&
          (!importantOnly || e.impact === 'High' || e.impact === 'Medium'),
      ),
    [events, usdOnly, importantOnly],
  );

  const nextId = shown.find((e) => e.time > now)?.id;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let day = '';
    for (const e of shown) {
      const d = new Date(e.time);
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (k !== day) {
        day = k;
        out.push({ type: 'day', key: k, label: `${WEEKDAY[d.getDay()]}, ${p2(d.getDate())}/${p2(d.getMonth() + 1)}` });
      }
      out.push({ type: 'event', key: e.id, e });
    }
    return out;
  }, [shown]);

  if (loading) return <ActivityIndicator color={colors.muted} style={{ marginTop: sz(40) }} />;

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          tintColor={colors.muted}
          colors={[colors.warn]}
          progressBackgroundColor={colors.card}
        />
      }
      ListHeaderComponent={
        <>
          <View style={styles.filters}>
            <Chip label="Chỉ USD" active={usdOnly} onPress={() => setUsdOnly((v) => !v)} />
            <Chip label="Tác động cao/TB" active={importantOnly} onPress={() => setImportantOnly((v) => !v)} />
          </View>
          <Text style={styles.hint}>Giờ Việt Nam theo máy · tin USD tác động mạnh thường làm vàng biến động lớn</Text>
          {error && <Text style={styles.error}>{error}</Text>}
        </>
      }
      ListEmptyComponent={!error ? <Text style={styles.empty}>Không có sự kiện.</Text> : undefined}
      renderItem={({ item }) =>
        item.type === 'day' ? (
          <Text style={styles.day}>{item.label}</Text>
        ) : (
          <EventRow e={item.e} now={now} next={item.e.id === nextId} />
        )
      }
    />
  );
}

function EventRow({ e, now, next }: { e: CalendarEvent; now: number; next: boolean }) {
  const d = new Date(e.time);
  const past = e.time < now;
  const imp = IMPACT[e.impact] ?? IMPACT.Low;
  return (
    <View style={[styles.event, next && styles.eventNext, past && { opacity: 0.45 }]}>
      <View style={styles.eventTime}>
        <Text style={styles.time}>{`${p2(d.getHours())}:${p2(d.getMinutes())}`}</Text>
        <Text style={styles.country}>{e.country}</Text>
      </View>
      <View style={[styles.impact, { backgroundColor: imp.color }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.eventTitle} numberOfLines={2}>
          {e.titleVi ?? e.title}
        </Text>
        {e.titleVi && <Text style={styles.eventSub}>{e.title}</Text>}
        {(e.forecast || e.previous) && (
          <Text style={styles.eventSub}>
            {e.forecast ? `Dự báo ${e.forecast}` : ''}
            {e.forecast && e.previous ? '  ·  ' : ''}
            {e.previous ? `Trước ${e.previous}` : ''}
          </Text>
        )}
        {next && <Text style={styles.countdown}>⏱ {countdown(e.time - now)}</Text>}
      </View>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = createStyles({
  gold: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  goldLabel: { color: colors.warn, fontSize: 12, fontWeight: '800' },
  goldPrice: { color: colors.text, fontSize: 15, fontWeight: '700' },
  goldChange: { fontSize: 12, fontWeight: '700' },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 6,
    backgroundColor: colors.card,
    borderRadius: 8,
    padding: 3,
  },
  tab: { height: 42, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  tabActive: { borderRadius: 6, backgroundColor: colors.cardAlt },
  tabText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.text, fontWeight: '700' },
  list: { paddingHorizontal: 12, paddingBottom: 16, gap: 8 },
  card: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 12,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '600', lineHeight: 22 },
  summary: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  metaText: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  newBadge: {
    color: colors.bg,
    backgroundColor: colors.warn,
    fontSize: 11,
    fontWeight: '800',
    paddingHorizontal: 4,
    borderRadius: 3,
    overflow: 'hidden',
  },
  thumb: { width: 84, height: 63, borderRadius: 6, backgroundColor: colors.cardAlt },
  error: { color: colors.short, fontSize: 12, marginBottom: 6 },
  empty: { color: colors.muted, fontSize: 13, textAlign: 'center', marginTop: 30 },
  filters: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  chip: {
    paddingHorizontal: 12,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { borderColor: colors.warn, backgroundColor: colors.cardAlt },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 11, marginBottom: 4 },
  day: { color: colors.warn, fontSize: 13, fontWeight: '800', marginTop: 8 },
  event: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    backgroundColor: colors.card,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  eventNext: { borderColor: colors.warn },
  eventTime: { width: 44, alignItems: 'center' },
  time: { color: colors.text, fontSize: 14, fontWeight: '700' },
  country: { color: colors.muted, fontSize: 11, fontWeight: '700', marginTop: 2 },
  impact: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  eventTitle: { color: colors.text, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  eventSub: { color: colors.muted, fontSize: 11, marginTop: 2 },
  countdown: { color: colors.warn, fontSize: 12, fontWeight: '700', marginTop: 4 },
});
