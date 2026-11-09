// News feeds (RSS) and the weekly economic calendar, fetched straight from the publishers.

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  time: number; // ms, 0 when unknown
  summary?: string;
  image?: string;
  /** Set on foreign-language items, which get translated. */
  lang?: 'en';
}

export interface Feed {
  key: string;
  label: string;
  lang?: 'en';
  urls: { url: string; source?: string }[];
  /** Publishers to drop (chart snapshots, social posts…). */
  exclude?: RegExp;
}

const gnews = (q: string, lang: 'vi' | 'en') =>
  lang === 'vi'
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=vi&gl=VN&ceid=VN:vi`
    : `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

export const FEEDS: Feed[] = [
  {
    key: 'gold-vi',
    label: 'Giá vàng',
    urls: [{ url: gnews('giá vàng when:2d', 'vi') }],
  },
  {
    key: 'world-vi',
    label: 'Thế giới',
    urls: [
      { url: gnews('Fed OR "lãi suất Mỹ" OR "lạm phát Mỹ" OR "đồng USD" OR "Phố Wall" OR "giá dầu" when:2d', 'vi') },
      { url: gnews('"kinh tế thế giới" OR "ông Trump" OR "Trung Quốc" OR "chiến sự" when:1d', 'vi') },
    ],
  },
  {
    key: 'gold-en',
    label: 'Quốc tế',
    lang: 'en',
    urls: [
      { url: gnews('"spot gold" OR "gold futures" OR XAUUSD OR bullion when:2d', 'en') },
      { url: 'https://www.investing.com/rss/news_11.rss', source: 'Investing.com' },
    ],
    exclude: /TradingView|Moomoo|Vietnam\.vn|Instagram|YouTube|Facebook/i,
  },
];

// ---------- RSS parsing (no DOM in React Native, feeds are simple enough for regex) ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(\w+);/g, (m, n) => ENTITIES[n] ?? m);
}

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
};

const stripHtml = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** RFC 822 date ("Wed, 04 Nov 26 09:43:00 +0700"); Hermes' Date.parse is not reliable for it. */
export function parseRssDate(s: string): number {
  const m = s.match(/(\d{1,2})\s+(\w{3})\w*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|Z|[+-]\d{4})?/i);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }
  const [, d, mon, y, h, mi, sec, zone] = m;
  const month = MONTHS[mon.toLowerCase()];
  if (month === undefined) return 0;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  let t = Date.UTC(year, month, Number(d), Number(h), Number(mi), Number(sec ?? 0));
  if (zone && /^[+-]/.test(zone)) {
    const sign = zone[0] === '-' ? -1 : 1;
    t -= sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60_000;
  }
  return t;
}

function parseRss(xml: string, fallbackSource?: string): NewsItem[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return items.flatMap((it) => {
    let title = stripHtml(tag(it, 'title'));
    const link = tag(it, 'link');
    if (!title || !link) return [];
    // Google News appends " - Publisher" to titles and names it in <source>.
    let source = stripHtml(tag(it, 'source')) || fallbackSource || '';
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3);
    else if (!source) {
      const dash = title.lastIndexOf(' - ');
      if (dash > 20) {
        source = title.slice(dash + 3);
        title = title.slice(0, dash);
      }
    }
    const rawDesc = tag(it, 'description');
    const image = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? it.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1];
    // Google News descriptions are just a list of related links: not worth showing.
    const summary = /news\.google\.com/.test(link) ? undefined : stripHtml(rawDesc).slice(0, 220) || undefined;
    return [{ id: link, title, link, source, time: parseRssDate(tag(it, 'pubDate')), summary, image }];
  });
}

async function fetchText(url: string, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 9)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const normTitle = (t: string) => t.toLowerCase().replace(/[\s.,:;!?"'“”‘’()|–—-]+/g, ' ').trim();

/** All sources of a feed, merged, de-duplicated and newest first. Fails only if every source fails. */
export async function fetchFeed(feed: Feed): Promise<NewsItem[]> {
  const results = await Promise.allSettled(feed.urls.map((u) => fetchText(u.url).then((x) => parseRss(x, u.source))));
  const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
  const seen = new Set<string>();
  return ok
    .flat()
    .filter((n) => {
      if (feed.exclude?.test(n.source)) return false;
      const k = normTitle(n.title);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, 80)
    .map((n) => (feed.lang ? { ...n, lang: feed.lang } : n));
}

// ---------- Economic calendar ----------

export type Impact = 'High' | 'Medium' | 'Low' | 'Holiday';

export interface CalendarEvent {
  id: string;
  title: string;
  titleVi?: string;
  country: string;
  time: number;
  impact: Impact;
  forecast: string;
  previous: string;
}

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

// Vietnamese names for the releases that move gold the most.
const EVENT_VI: [RegExp, string][] = [
  [/Non-Farm Employment Change/i, 'Bảng lương phi nông nghiệp (NFP)'],
  [/Unemployment Rate/i, 'Tỷ lệ thất nghiệp'],
  [/Core CPI/i, 'CPI lõi (lạm phát lõi)'],
  [/^CPI/i, 'Chỉ số giá tiêu dùng (CPI)'],
  [/Core PCE/i, 'PCE lõi (thước đo lạm phát của Fed)'],
  [/Core PPI|^PPI/i, 'Chỉ số giá sản xuất (PPI)'],
  [/Federal Funds Rate/i, 'Quyết định lãi suất Fed'],
  [/FOMC Statement/i, 'Tuyên bố FOMC'],
  [/FOMC Press Conference/i, 'Họp báo FOMC'],
  [/FOMC Meeting Minutes/i, 'Biên bản họp FOMC'],
  [/Fed Chair .* Speaks/i, 'Chủ tịch Fed phát biểu'],
  [/FOMC Member .* Speaks/i, 'Thành viên FOMC phát biểu'],
  [/Advance GDP|Prelim GDP|Final GDP|GDP q\/q/i, 'Tăng trưởng GDP'],
  [/Unemployment Claims/i, 'Đơn xin trợ cấp thất nghiệp'],
  [/ADP Non-Farm/i, 'Việc làm ADP'],
  [/JOLTS/i, 'Số việc làm trống JOLTS'],
  [/ISM Manufacturing PMI/i, 'PMI sản xuất ISM'],
  [/ISM Services PMI/i, 'PMI dịch vụ ISM'],
  [/Retail Sales/i, 'Doanh số bán lẻ'],
  [/Average Hourly Earnings/i, 'Thu nhập bình quân theo giờ'],
  [/Consumer Sentiment/i, 'Niềm tin người tiêu dùng'],
  [/Durable Goods/i, 'Đơn hàng hàng hóa lâu bền'],
];

let calendarCache: { at: number; data: CalendarEvent[] } | null = null;
// The source rate-limits hard (HTTP 429) and only changes a few times a day.
const CALENDAR_TTL = 30 * 60_000;

export async function fetchCalendar(): Promise<CalendarEvent[]> {
  if (calendarCache && Date.now() - calendarCache.at < CALENDAR_TTL) return calendarCache.data;
  let text: string;
  try {
    text = await fetchText(CALENDAR_URL);
  } catch (e) {
    if (calendarCache) return calendarCache.data;
    throw /429/.test(String(e)) ? new Error('Nguồn lịch đang giới hạn lượt tải, thử lại sau vài phút') : e;
  }
  const raw = JSON.parse(text) as {
    title: string;
    country: string;
    date: string;
    impact: Impact;
    forecast: string;
    previous: string;
  }[];
  const data = raw
    .map<CalendarEvent>((e, i) => ({
      id: `${e.date}|${e.country}|${e.title}|${i}`,
      title: e.title,
      titleVi: EVENT_VI.find(([re]) => re.test(e.title))?.[1],
      country: e.country,
      time: Date.parse(e.date), // ISO 8601 with offset: safe to parse
      impact: e.impact,
      forecast: e.forecast,
      previous: e.previous,
    }))
    .filter((e) => Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time);
  calendarCache = { at: Date.now(), data };
  return data;
}
