import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import { Animated, Easing, Linking, Modal, Pressable, Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewProps } from 'react-native-webview';

import type { NewsItem } from '../api/news';
import { translateArticle } from '../api/translate';
import { tap } from '../haptics';
import { createStyles, colors } from '../theme';
import { READER_JS, setFontSizeJs } from './readerScript';

// The class component's typings don't resolve against React 19.3's: describe its props directly.
const Web = WebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebView> }>;

const FONT_KEY = 'reader_font_v1';
const FONT_SIZES = [15, 16, 17, 18, 20, 22, 24];
const READER_TIMEOUT_MS = 9_000;
const isGoogleNews = (url: string) => /^https?:\/\/news\.google\.com\//i.test(url);

let savedFont = 18;
SecureStore.getItemAsync(FONT_KEY)
  .then((v) => v && (savedFont = Number(v) || savedFont))
  .catch(() => {});

/** Full-screen in-app reader: clean dark reading view, with the original page one tap away. */
export function ArticleViewer({ item, onClose }: { item: NewsItem | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const [progress, setProgress] = useState(0);
  const [readPct, setReadPct] = useState(0);
  const [canGoBack, setCanGoBack] = useState(false);
  const [url, setUrl] = useState('');
  const [readerMode, setReaderMode] = useState(true);
  // 'loading' keeps the placeholder over the page until the reader view is ready.
  const [view, setView] = useState<'loading' | 'reader' | 'web'>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [font, setFont] = useState(savedFont);
  const [fontPanel, setFontPanel] = useState(false);
  const attempts = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fresh state for every article.
  useEffect(() => {
    setProgress(0);
    setCanGoBack(false);
    setUrl('');
    setReaderMode(true);
    setView('loading');
    setNotice(null);
    setFontPanel(false);
    setFont(savedFont);
    attempts.current = 0;
  }, [item]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2_500);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => () => void (timeout.current && clearTimeout(timeout.current)), []);

  const close = () => {
    if (timeout.current) clearTimeout(timeout.current);
    onClose();
  };

  const showOriginal = (why?: string) => {
    if (timeout.current) clearTimeout(timeout.current);
    setView('web');
    if (why) setNotice(why);
  };

  const injectReader = () => {
    web.current?.injectJavaScript(`window.__readerFs=${font};window.__readerTranslate=${item?.lang === 'en'};` + READER_JS);
  };

  // Bumped whenever the page changes, so a slow translation can't write into the next article.
  const translationRun = useRef(0);
  useEffect(() => {
    translationRun.current += 1;
  }, [item, url, readerMode]);

  const startTranslation = (paragraphs: string[]) => {
    const run = ++translationRun.current;
    const isAlive = () => run === translationRun.current;
    setNotice('Đang dịch sang tiếng Việt…');
    translateArticle(
      paragraphs,
      (from, translated) =>
        web.current?.injectJavaScript(`window.__applyTranslation&&window.__applyTranslation(${from},${JSON.stringify(translated)});true;`),
      isAlive,
    )
      .then(() => isAlive() && setNotice(null))
      .catch((e) => isAlive() && setNotice(`Chưa dịch được: ${e instanceof Error ? e.message : 'lỗi'}`));
  };

  const onLoadEnd = (loadedUrl: string) => {
    if (!readerMode) return setView('web');
    if (isGoogleNews(loadedUrl)) return; // still redirecting to the publisher
    injectReader();
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => showOriginal('Trang tải chậm, đang hiện bản gốc'), READER_TIMEOUT_MS);
  };

  const onMessage = (data: string) => {
    let msg: { reader?: boolean; read?: number; paragraphs?: string[] };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.read === 'number') return setReadPct(msg.read);
    if (msg.paragraphs) return startTranslation(msg.paragraphs);
    if (msg.reader) {
      if (timeout.current) clearTimeout(timeout.current);
      setReadPct(0);
      setView('reader');
    } else if (attempts.current < 2) {
      // Content rendered by scripts may not be there yet: try again shortly.
      attempts.current += 1;
      setTimeout(injectReader, 1_200);
    } else {
      showOriginal('Trang này không hỗ trợ chế độ đọc');
    }
  };

  const toggleReader = () => {
    tap();
    const next = !readerMode;
    setReaderMode(next);
    attempts.current = 0;
    setView(next ? 'loading' : 'web');
    web.current?.reload();
  };

  const changeFont = (dir: 1 | -1) => {
    tap();
    const i = FONT_SIZES.indexOf(font);
    const next = FONT_SIZES[Math.min(Math.max((i < 0 ? 3 : i) + dir, 0), FONT_SIZES.length - 1)];
    setFont(next);
    savedFont = next;
    SecureStore.setItemAsync(FONT_KEY, String(next)).catch(() => {});
    web.current?.injectJavaScript(setFontSizeJs(next));
  };

  const link = url && !isGoogleNews(url) ? url : item?.link ?? '';

  return (
    <Modal
      visible={item !== null}
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      // Hardware back walks back through the article's pages before closing.
      onRequestClose={() => (fontPanel ? setFontPanel(false) : canGoBack && view === 'web' ? web.current?.goBack() : close())}
    >
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.bar}>
          <IconBtn label="‹" a11y="Đóng" big onPress={close} />
          <View style={styles.titleBox}>
            <Text style={styles.source} numberOfLines={1}>
              {item?.source || 'Tin tức'}
            </Text>
            <Text style={styles.host} numberOfLines={1}>
              {view === 'reader' ? 'Chế độ đọc' : hostOf(link)}
            </Text>
          </View>
          {readerMode && view !== 'web' && (
            <IconBtn label="Aa" a11y="Cỡ chữ" active={fontPanel} onPress={() => setFontPanel((v) => !v)} />
          )}
          {/* Names the mode it switches to. */}
          <IconBtn label={readerMode ? 'Gốc' : 'Đọc'} a11y={readerMode ? 'Xem trang gốc' : 'Chế độ đọc'} onPress={toggleReader} />
          <IconBtn
            label="⇪"
            a11y="Chia sẻ"
            onPress={() => item && Share.share({ message: `${item.title}\n${link}` }).catch(() => {})}
          />
          <IconBtn label="↗" a11y="Mở bằng trình duyệt" onPress={() => Linking.openURL(link).catch(() => {})} />
        </View>
        <View style={styles.track}>
          {view === 'reader'
            ? readPct > 0 && <View style={[styles.progress, { width: `${readPct * 100}%` }]} />
            : progress > 0 && progress < 1 && <View style={[styles.progress, { width: `${progress * 100}%` }]} />}
        </View>

        {fontPanel && (
          <View style={styles.fontPanel}>
            <Pressable onPress={() => changeFont(-1)} style={styles.fontBtn} hitSlop={6}>
              <Text style={[styles.fontBtnText, { fontSize: 14 }]}>A−</Text>
            </Pressable>
            <View style={styles.fontDots}>
              {FONT_SIZES.map((s) => (
                <View key={s} style={[styles.fontDot, s <= font && { backgroundColor: colors.warn }]} />
              ))}
            </View>
            <Pressable onPress={() => changeFont(1)} style={styles.fontBtn} hitSlop={6}>
              <Text style={[styles.fontBtnText, { fontSize: 20 }]}>A+</Text>
            </Pressable>
          </View>
        )}

        <View style={{ flex: 1 }}>
          {item && (
            <Web
              ref={web}
              source={{ uri: item.link }}
              style={{ flex: 1, backgroundColor: colors.bg }}
              containerStyle={{ backgroundColor: colors.bg }}
              originWhitelist={['http://*', 'https://*']}
              // Links that would open a new window load in place instead.
              setSupportMultipleWindows={false}
              // App-store / intent links would leave the app: ignore them.
              onShouldStartLoadWithRequest={(r) => /^https?:/i.test(r.url) || r.url === 'about:blank'}
              onLoadStart={(e) => {
                // Following a link inside the reader opens the next article in reader mode too.
                if (readerMode && !isGoogleNews(e.nativeEvent.url) && view === 'reader' && e.nativeEvent.url !== url) {
                  attempts.current = 0;
                  setView('loading');
                }
              }}
              onLoadEnd={(e) => onLoadEnd(e.nativeEvent.url)}
              onMessage={(e) => onMessage(e.nativeEvent.data)}
              onLoadProgress={(e) => setProgress(e.nativeEvent.progress)}
              onNavigationStateChange={(s) => {
                setCanGoBack(s.canGoBack);
                setUrl(s.url);
              }}
              mediaPlaybackRequiresUserAction
              javaScriptEnabled
              domStorageEnabled
            />
          )}
          {item && view === 'loading' && <Placeholder item={item} />}
          {notice && (
            <View style={styles.toast} pointerEvents="none">
              <Text style={styles.toastText}>{notice}</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** Shown over the page while it loads and is turned into the reading view. */
function Placeholder({ item }: { item: NewsItem }) {
  const pulse = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.8, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.placeholder}>
      <View style={styles.kicker}>
        <View style={styles.kickerDot} />
        <Text style={styles.kickerText} numberOfLines={1}>
          {item.source || 'Tin tức'}
        </Text>
      </View>
      <Text style={styles.phTitle}>{item.title}</Text>
      <View style={styles.phRule} />
      <Animated.View style={{ opacity: pulse }}>
        <View style={[styles.phBlock, { height: 190, marginBottom: 22 }]} />
        {[100, 96, 100, 88, 100, 72].map((w, i) => (
          <View key={i} style={[styles.phBlock, { width: `${w}%` }]} />
        ))}
      </Animated.View>
    </View>
  );
}

function IconBtn({ label, a11y, onPress, active, big }: { label: string; a11y: string; onPress: () => void; active?: boolean; big?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityRole="button" accessibilityLabel={a11y} style={({ pressed }) => [styles.btn, active && styles.btnActive, pressed && { opacity: 0.5 }]}>
      <Text style={[styles.icon, big && styles.iconBig, active && { color: colors.warn }]}>{label}</Text>
    </Pressable>
  );
}

function hostOf(url: string) {
  const m = url.match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].replace(/^www\./, '') : '';
}

const styles = createStyles({
  screen: { flex: 1, backgroundColor: colors.bg },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 52,
    paddingHorizontal: 6,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  titleBox: { flex: 1, paddingHorizontal: 4 },
  btn: { minWidth: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  btnActive: { backgroundColor: colors.card },
  icon: { color: colors.text, fontSize: 17, fontWeight: '700' },
  iconBig: { fontSize: 30, fontWeight: '400', marginTop: -4 },
  source: { color: colors.text, fontSize: 15, fontWeight: '800' },
  host: { color: colors.muted, fontSize: 12, marginTop: 1 },
  track: { height: 3 },
  progress: { height: 3, backgroundColor: colors.warn },
  fontPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 10,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.card,
  },
  fontBtn: { width: 44, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardAlt },
  fontBtnText: { color: colors.text, fontWeight: '800' },
  fontDots: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6 },
  fontDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  placeholder: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kickerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warn },
  kickerText: { color: colors.warn, fontSize: 12, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  phTitle: { color: colors.text, fontSize: 25, fontWeight: '800', lineHeight: 33, marginTop: 10 },
  phRule: { height: 1, backgroundColor: colors.border, marginVertical: 18 },
  phBlock: { height: 14, borderRadius: 7, backgroundColor: colors.cardAlt, marginBottom: 12 },
  toast: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: colors.sheet,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toastText: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
