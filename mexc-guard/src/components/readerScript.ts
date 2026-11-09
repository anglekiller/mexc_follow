// Injected into the article page: finds the main content (known Vietnamese news layouts first,
// then a paragraph-density heuristic), rebuilds the page as a clean dark reading view and
// reports back { reader: true|false }. Runs entirely inside the WebView.

export const READER_CSS = `
:root { --fs: 18px; color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #121212; }
body { color: #E4E4E4; font-family: 'Noto Serif', Georgia, serif; font-size: var(--fs);
  line-height: 1.72; -webkit-text-size-adjust: 100%; word-wrap: break-word; }
.wrap { max-width: 720px; margin: 0 auto; padding: 16px 16px 72px; }
.kicker { font-family: Roboto, system-ui, sans-serif; display: flex; align-items: center; gap: 8px;
  font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: #F0B90B; font-weight: 700; }
.kicker .dot { width: 6px; height: 6px; border-radius: 3px; background: #F0B90B; }
h1.title { font-family: Roboto, system-ui, sans-serif; font-size: calc(var(--fs) * 1.3); line-height: 1.32;
  font-weight: 800; color: #FFFFFF; margin: 10px 0 12px; letter-spacing: -.01em; }
.meta { font-family: Roboto, system-ui, sans-serif; font-size: 13px; color: #8A8F98;
  display: flex; flex-wrap: wrap; gap: 4px 12px; padding-bottom: 16px; border-bottom: 1px solid #2E2E2E; }
.lead { font-size: calc(var(--fs) * 1.05); color: #FFFFFF; font-weight: 600; margin: 18px 0; }
.hero { margin: 16px -16px 6px; }
.hero img { width: 100%; display: block; }
article p { margin: 0 0 1.05em; }
article h2, article h3, article h4 { font-family: Roboto, system-ui, sans-serif; color: #FFFFFF;
  line-height: 1.35; margin: 1.6em 0 .6em; font-size: calc(var(--fs) * 1.12); }
article a { color: #F0B90B; text-decoration: none; border-bottom: 1px solid rgba(240,185,11,.35); }
article img, article video { max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 8px; }
article figure { margin: 1.4em 0; }
article figcaption, .caption, .image-caption { font-family: Roboto, system-ui, sans-serif; font-size: 13px;
  color: #8A8F98; text-align: center; margin-top: 8px; line-height: 1.45; }
article blockquote { margin: 1.4em 0; padding: 4px 0 4px 16px; border-left: 3px solid #F0B90B; color: #CFCFCF; font-style: italic; }
article ul, article ol { padding-left: 1.3em; }
article li { margin-bottom: .45em; }
article table { width: 100%; border-collapse: collapse; font-family: Roboto, system-ui, sans-serif;
  font-size: 14px; margin: 1.2em 0; display: block; overflow-x: auto; }
article td, article th { border: 1px solid #2E2E2E; padding: 6px 8px; }
article th, article tr:first-child td { background: #1E1E1E; color: #FFFFFF; font-weight: 700; }
article strong, article b { color: #FFFFFF; }
.end { margin-top: 36px; text-align: center; color: #4A4F57; font-family: Roboto, sans-serif; font-size: 12px; letter-spacing: .3em; }
.src { margin-top: 10px; text-align: center; font-family: Roboto, sans-serif; font-size: 13px; }
`;

const script = (css: string) => `(function () {
  if (window.__reader) return;
  var post = function (o) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); };
  if (/(^|\\.)news\\.google\\.com$/.test(location.hostname)) return;
  try {
    var meta = function (sel) { var m = document.querySelector(sel); return m ? (m.getAttribute('content') || '').trim() : ''; };
    var KNOWN = ['[itemprop="articleBody"]', '.fck_detail', '.detail-content', '#mainContent', '.knc-content',
      '.detail__content', '.article-body', '.article__body', '.article-content', '.content-detail', '.detail-content-body',
      '.cms-body', '.singular-content', '.entry-content', '.post-content', '.news-content', '.maincontent',
      '.article__content', '.ArticleBody-articleBody', '.caas-body', '.story-body', 'article'];
    var textLen = function (el) { return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().length; };
    var best = null;
    for (var i = 0; i < KNOWN.length && !best; i++) {
      var els = document.querySelectorAll(KNOWN[i]);
      for (var j = 0; j < els.length; j++) if (textLen(els[j]) > 400 && (!best || textLen(els[j]) > textLen(best))) best = els[j];
    }
    if (!best) {
      // Heuristic: the element whose direct <p> children hold the most text.
      var scores = new Map();
      document.querySelectorAll('p').forEach(function (p) {
        var n = textLen(p); if (n < 40) return;
        var par = p.parentElement; if (!par) return;
        scores.set(par, (scores.get(par) || 0) + n);
        if (par.parentElement) scores.set(par.parentElement, (scores.get(par.parentElement) || 0) + n / 2);
      });
      var top = 0; scores.forEach(function (v, k) { if (v > top) { top = v; best = k; } });
    }
    if (!best || textLen(best) < 500) return post({ reader: false });

    var body = best.cloneNode(true);
    var JUNK = 'script,style,noscript,iframe,form,input,button,select,textarea,nav,aside,footer,header,svg,canvas,' +
      '[class*="relate"],[class*="Relate"],[class*="share"],[class*="social"],[class*="comment"],[class*="banner"],' +
      '[class*="advert"],[class*=" ads"],[class^="ads"],[id*="ads"],[class*="quangcao"],[class*="tag-list"],[class*="tags"],' +
      '[class*="newsletter"],[class*="subscribe"],[class*="readmore"],[class*="read-more"],[class*="box-tin"],[class*="author-info"],' +
      '[class*="breadcrumb"],[class*="sapo-mobile"],[class*="audio"],[class*="player"],[aria-hidden="true"],[hidden]';
    body.querySelectorAll(JUNK).forEach(function (n) { n.remove(); });
    // Lazy-loaded images keep their real URL in data-* attributes.
    body.querySelectorAll('img').forEach(function (img) {
      var src = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') ||
        img.getAttribute('data-srcset') || img.getAttribute('src') || '';
      src = src.split(' ')[0];
      if (!src || /^data:/.test(src) || /(logo|icon|avatar|pixel|blank)/i.test(src)) { img.remove(); return; }
      img.setAttribute('src', new URL(src, location.href).href);
      ['srcset', 'sizes', 'width', 'height', 'style', 'loading'].forEach(function (a) { img.removeAttribute(a); });
    });
    body.querySelectorAll('*').forEach(function (n) {
      for (var k = n.attributes.length - 1; k >= 0; k--) {
        var a = n.attributes[k].name;
        if (a === 'style' || a.indexOf('on') === 0 || a === 'class' || a === 'id' || a === 'width' || a === 'height') n.removeAttribute(a);
      }
    });
    // Drop now-empty wrappers.
    body.querySelectorAll('div,span,p,section').forEach(function (n) {
      if (!n.querySelector('img,video,table') && !(n.textContent || '').trim()) n.remove();
    });

    var title = meta('meta[property="og:title"]') || (document.querySelector('h1') || {}).innerText || document.title;
    // The headline is rendered separately: drop the page's own copy (and anything above it, e.g. category/byline).
    var norm = function (t) { return (t || '').replace(/\\s+/g, ' ').trim().toLowerCase(); };
    body.querySelectorAll('h1,h2').forEach(function (h) {
      if (h.tagName === 'H1' || norm(h.textContent) === norm(title)) {
        var prev = h.previousElementSibling;
        while (prev) { var p0 = prev.previousElementSibling; if (!prev.querySelector('img')) prev.remove(); prev = p0; }
        h.remove();
      }
    });
    var site = meta('meta[property="og:site_name"]') || location.hostname.replace(/^www\\./, '');
    var lead = meta('meta[property="og:description"]') || meta('meta[name="description"]');
    var hero = meta('meta[property="og:image"]');
    var when = meta('meta[property="article:published_time"]') || meta('meta[itemprop="datePublished"]') ||
      ((document.querySelector('time[datetime]') || { getAttribute: function () { return ''; } }).getAttribute('datetime'));
    var words = (body.textContent || '').trim().split(/\\s+/).length;
    var firstImg = body.querySelector('img');
    // The same photo is often served from another CDN size/query: compare by file name.
    var fileOf = function (u) { return (u || '').split('?')[0].split('/').pop(); };
    if (hero && firstImg && fileOf(firstImg.getAttribute('src')) === fileOf(hero)) hero = '';
    var bodyText = (body.textContent || '').replace(/\\s+/g, ' ');
    if (lead && bodyText.indexOf(lead.slice(0, 60)) >= 0) lead = '';

    var fmtDate = function (s) {
      var d = new Date(s); if (!s || isNaN(d)) return '';
      var p = function (x) { return (x < 10 ? '0' : '') + x; };
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ' · ' + p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    };
    var fs = getComputedStyle(document.documentElement).getPropertyValue('--fs');

    // Stop the page's own scripts from re-inserting ads into the rebuilt document.
    try { window.stop(); } catch (e) {}
    var last = setTimeout(function () {}, 0);
    for (var t = 1; t <= last; t++) { clearTimeout(t); clearInterval(t); }
    var root = document.documentElement;
    while (root.attributes.length) root.removeAttribute(root.attributes[0].name);
    root.setAttribute('lang', 'vi');
    root.innerHTML = '<head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' + ${JSON.stringify(css)} + '</style></head>' +
      '<body><div class="wrap"><div class="kicker"><span class="dot"></span><span id="k"></span></div>' +
      '<h1 class="title" id="t"></h1><div class="meta"><span id="d"></span><span id="r"></span></div>' +
      '<div class="hero" id="h"></div><p class="lead" id="l"></p><article id="a"></article>' +
      '<div class="end">• • •</div><div class="src"><a id="o" style="color:#8A8F98"></a></div></div></body>';
    var $ = function (id) { return document.getElementById(id); };
    $('k').textContent = site;
    $('t').textContent = title.trim();
    $('d').textContent = fmtDate(when);
    $('r').textContent = Math.max(1, Math.round(words / 220)) + ' phút đọc';
    if (hero) { var hi = document.createElement('img'); hi.src = hero; hi.onerror = function () { $('h').remove(); }; $('h').appendChild(hi); } else $('h').remove();
    if (lead) $('l').textContent = lead; else $('l').remove();
    $('a').appendChild(body);
    $('o').textContent = 'Nguồn: ' + site;
    $('o').href = location.href;
    if (window.__readerFs) document.documentElement.style.setProperty('--fs', window.__readerFs + 'px');
    window.__reader = true;
    window.scrollTo(0, 0);
    post({ reader: true });
    if (window.__readerTranslate) {
      // Leaf text blocks only, so nothing is translated twice. Translations replace them in place.
      var BLOCKS = 'p,li,h2,h3,h4,blockquote,figcaption,td,th';
      var nodes = [$('t'), $('l')].concat(Array.prototype.slice.call($('a').querySelectorAll(BLOCKS)))
        .filter(function (n) { return n && (n.textContent || '').trim() && !n.querySelector(BLOCKS); });
      window.__applyTranslation = function (from, list) {
        for (var i = 0; i < list.length; i++) if (nodes[from + i] && list[i]) nodes[from + i].textContent = list[i];
      };
      post({ paragraphs: nodes.map(function (n) { return n.textContent.replace(/\\s+/g, ' ').trim(); }) });
    }
    // Reading progress, in 2% steps so scrolling doesn't flood the bridge.
    var lastRead = 0, ticking = false;
    var report = function () {
      ticking = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var read = max > 0 ? Math.round(Math.min(1, window.scrollY / max) * 50) / 50 : 0;
      if (read !== lastRead) { lastRead = read; post({ read: read }); }
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(report); }
    }, { passive: true });
  } catch (e) {
    post({ reader: false, error: String(e) });
  }
})(); true;`;

export const READER_JS = script(READER_CSS);

export const setFontSizeJs = (px: number) =>
  `window.__readerFs=${px};document.documentElement.style.setProperty('--fs','${px}px');true;`;
