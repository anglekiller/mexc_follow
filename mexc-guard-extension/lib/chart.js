// Canvas price chart: candles / OHLC bars / line, volume, crosshair, wheel zoom, drag pan,
// position lines (pinned to the edge when far away) and a live last-price tag.

const C = { bg: '#1e1e1e', grid: '#2a2a2a', text: '#8a8f98', up: '#00c087', down: '#f6465d', line: '#f0b90b', cross: '#8a8f98' };
const AXIS_W = 58;
const TIME_H = 16;
const VOL_H = 0.16;
const PAD_Y = 8;
const MARK_REACH = 0.5;

const p2 = (n) => String(n).padStart(2, '0');
function fmt(n, d) {
  const [i, f] = Math.abs(n).toFixed(d).split('.');
  return `${n < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}
function timeLabel(sec, intervalSec) {
  const d = new Date(sec * 1000);
  const day = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
  return intervalSec >= 86400 ? `${day}/${String(d.getFullYear()).slice(2)}` : `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export class PriceChart {
  constructor(canvas, onReadout) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onReadout = onReadout;
    this.candles = [];
    this.type = 'candle';
    this.zoom = 8; // px per candle
    this.offset = 0; // candles scrolled back from the newest
    this.marks = [];
    this.priceScale = 2;
    this.intervalSec = 900;
    this.live = undefined;
    this.mouse = null;

    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.min(30, Math.max(2, this.zoom * (e.deltaY > 0 ? 0.88 : 1.14)));
      this.draw();
    }, { passive: false });
    canvas.addEventListener('mousedown', (e) => {
      const start = { x: e.clientX, off: this.offset };
      const move = (ev) => {
        this.offset = Math.max(0, Math.min(this.maxOffset(), Math.round(start.off + (ev.clientX - start.x) / this.zoom)));
        this.draw();
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => { this.mouse = null; this.draw(); });
    canvas.addEventListener('dblclick', () => { this.offset = 0; this.zoom = 8; this.draw(); });
  }

  setData(candles, { reset, priceScale, intervalSec, marks, live }) {
    this.candles = candles;
    this.priceScale = priceScale;
    this.intervalSec = intervalSec;
    this.marks = marks ?? [];
    if (reset) this.offset = 0;
    this.live = live;
    this.draw();
  }

  setType(t) { this.type = t; this.draw(); }
  setLive(price) { if (price !== undefined && price !== this.live) { this.live = price; this.draw(); } }

  maxOffset() {
    const w = this.cv.clientWidth - AXIS_W;
    return Math.max(this.candles.length - Math.floor(w / this.zoom), 0);
  }

  draw() {
    const cv = this.cv;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.font = '10px Roboto, Segoe UI, sans-serif';
    g.textBaseline = 'middle';

    // The newest candle follows the live price between polls.
    let data = this.candles;
    if (data.length && this.live !== undefined) {
      const l = data[data.length - 1];
      data = [...data.slice(0, -1), { ...l, close: this.live, high: Math.max(l.high, this.live), low: Math.min(l.low, this.live) }];
    }
    if (!data.length) {
      g.fillStyle = C.text;
      g.fillText('Đang tải biểu đồ…', W / 2 - 45, H / 2);
      return;
    }

    const plotW = W - AXIS_W;
    const plotH = H - TIME_H;
    const priceH = plotH * (1 - VOL_H);
    const count = Math.max(Math.floor(plotW / this.zoom), 1);
    const off = Math.min(this.offset, this.maxOffset());
    const vis = data.slice(Math.max(data.length - off - count, 0), data.length - off);

    let hi = -Infinity, lo = Infinity, maxVol = 0;
    for (const c of vis) {
      hi = Math.max(hi, this.type === 'line' ? c.close : c.high);
      lo = Math.min(lo, this.type === 'line' ? c.close : c.low);
      maxVol = Math.max(maxVol, c.vol);
    }
    const span = hi - lo;
    for (const m of this.marks) {
      if (m.price > 0 && m.price <= hi + span * MARK_REACH && m.price >= lo - span * MARK_REACH) {
        hi = Math.max(hi, m.price);
        lo = Math.min(lo, m.price);
      }
    }
    if (hi === lo) { hi += 1; lo -= 1; }
    const y = (p) => PAD_Y + ((hi - p) / (hi - lo)) * (priceH - PAD_Y * 2);
    const priceAt = (py) => hi - ((py - PAD_Y) / (priceH - PAD_Y * 2)) * (hi - lo);
    const cx = (i) => i * this.zoom + this.zoom / 2;
    const dp = this.priceScale;

    // Grid + price axis.
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    g.fillStyle = C.text;
    for (let k = 0; k <= 4; k++) {
      const py = PAD_Y + (k / 4) * (priceH - PAD_Y * 2);
      g.beginPath(); g.moveTo(0, Math.round(py) + 0.5); g.lineTo(plotW, Math.round(py) + 0.5); g.stroke();
      g.fillText(fmt(priceAt(py), dp), plotW + 4, py);
    }

    // Volume.
    vis.forEach((c, i) => {
      const h = maxVol ? (c.vol / maxVol) * plotH * VOL_H : 0;
      g.fillStyle = (c.close >= c.open ? C.up : C.down) + '40';
      g.fillRect(i * this.zoom + 1, plotH - h, Math.max(this.zoom - 2, 1), h);
    });

    // Price.
    if (this.type === 'line') {
      g.strokeStyle = C.line; g.lineWidth = 1.5; g.beginPath();
      vis.forEach((c, i) => (i ? g.lineTo(cx(i), y(c.close)) : g.moveTo(cx(i), y(c.close))));
      g.stroke();
    } else {
      const body = Math.max(this.zoom * 0.65, 1);
      vis.forEach((c, i) => {
        const col = c.close >= c.open ? C.up : C.down;
        const x = Math.round(cx(i)) + 0.5;
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, y(c.high)); g.lineTo(x, y(c.low)); g.stroke();
        if (this.type === 'candle') {
          const top = y(Math.max(c.open, c.close));
          g.fillRect(x - body / 2, top, body, Math.max(y(Math.min(c.open, c.close)) - top, 1));
        } else {
          const t = Math.max(this.zoom / 2.5, 2);
          g.beginPath(); g.moveTo(x - t, y(c.open)); g.lineTo(x, y(c.open)); g.moveTo(x, y(c.close)); g.lineTo(x + t, y(c.close)); g.stroke();
        }
      });
    }

    // Time axis.
    g.fillStyle = C.text;
    const every = Math.max(Math.ceil(90 / this.zoom), 1);
    for (let i = vis.length - 1; i >= 0; i -= every) {
      const label = timeLabel(vis[i].time, this.intervalSec);
      const w = g.measureText(label).width;
      g.fillText(label, Math.min(Math.max(cx(i) - w / 2, 0), plotW - w), plotH + TIME_H / 2);
    }

    // Position lines; off-scale ones become edge labels.
    let up = 0, down = 0;
    g.setLineDash([4, 3]);
    for (const m of this.marks) {
      if (!(m.price > 0)) continue;
      g.fillStyle = m.color; g.strokeStyle = m.color;
      if (m.price <= hi && m.price >= lo) {
        const py = Math.round(y(m.price)) + 0.5;
        g.beginPath(); g.moveTo(0, py); g.lineTo(plotW, py); g.stroke();
        g.fillText(m.label, 4, py - 7);
      } else {
        const label = `${m.price > hi ? '▲' : '▼'} ${m.label} ${fmt(m.price, dp)}`;
        g.fillText(label, 4, m.price > hi ? 8 + 13 * up++ : priceH - 8 - 13 * down++);
      }
    }

    // Last price.
    const last = vis[vis.length - 1];
    if (off === 0 && last) {
      const py = Math.round(y(last.close)) + 0.5;
      g.strokeStyle = '#ffffff55';
      g.beginPath(); g.moveTo(0, py); g.lineTo(plotW, py); g.stroke();
      this.tag(plotW, py, fmt(last.close, dp), last.close >= last.open ? C.up : C.down);
    }
    g.setLineDash([]);

    // Crosshair.
    if (this.mouse && this.mouse.x < plotW && this.mouse.y < plotH) {
      const i = Math.min(Math.max(Math.floor(this.mouse.x / this.zoom), 0), vis.length - 1);
      const c = vis[i];
      g.strokeStyle = C.cross; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(cx(i)) + 0.5, 0); g.lineTo(Math.round(cx(i)) + 0.5, plotH);
      g.moveTo(0, Math.round(this.mouse.y) + 0.5); g.lineTo(plotW, Math.round(this.mouse.y) + 0.5); g.stroke();
      g.setLineDash([]);
      if (this.mouse.y < priceH) this.tag(plotW, this.mouse.y, fmt(priceAt(this.mouse.y), dp), '#3a3a3a');
      const tl = timeLabel(c.time, this.intervalSec);
      const tw = g.measureText(tl).width + 8;
      const tx = Math.min(Math.max(cx(i) - tw / 2, 0), plotW - tw);
      g.fillStyle = '#3a3a3a'; g.fillRect(tx, plotH, tw, TIME_H);
      g.fillStyle = '#fff'; g.fillText(tl, tx + 4, plotH + TIME_H / 2);
      this.onReadout?.({ o: fmt(c.open, dp), h: fmt(c.high, dp), l: fmt(c.low, dp), c: fmt(c.close, dp) });
    } else {
      this.onReadout?.(null);
    }
  }

  tag(x, y, text, color) {
    const g = this.ctx;
    g.fillStyle = color;
    g.fillRect(x, y - 8, AXIS_W, 16);
    g.fillStyle = '#fff';
    g.fillText(text, x + 4, y);
  }
}
