import { generate } from '../alerts/gemini';
import { loadAlertSettings, loadGeminiKey } from '../alerts/settings';
import type { MarketView } from './analyze';

/** Gemini's entry plan for one instrument. */
export interface AiPlan {
  bias: 'LONG' | 'SHORT' | 'WAIT';
  entryLow?: number;
  entryHigh?: number;
  sl?: number;
  tp1?: number;
  tp2?: number;
  /** 0–100. */
  confidence: number;
  reason: string;
  risks: string;
  model: string;
  time: number;
}

const SYSTEM = [
  'Bạn là chuyên gia phân tích kỹ thuật hàng hóa (vàng, bạc, dầu) cho trader hợp đồng vĩnh cửu.',
  'Chỉ dựa trên số liệu được cung cấp, không bịa thêm tin tức hay số liệu.',
  'Ưu tiên bảo toàn vốn: nếu tín hiệu không rõ hoặc R:R dưới 1.5 thì chọn WAIT.',
  'SL phải đặt ở mức kỹ thuật hợp lý (ngoài vùng nhiễu ~1 ATR H1). TP1 tối thiểu 1.5R.',
  'Trả lời JSON đúng schema: {"bias":"LONG|SHORT|WAIT","entryLow":number|null,"entryHigh":number|null,"sl":number|null,"tp1":number|null,"tp2":number|null,"confidence":0-100,"reason":"tiếng Việt, ≤ 3 câu","risks":"tiếng Việt, ≤ 2 câu"}.',
].join(' ');

const f = (n: number, d = 4) => Number(n.toFixed(d));

function prompt(v: MarketView) {
  const candles = v.recentH1
    .map((c) => `${new Date(c.time * 1000).getUTCHours()}h O${f(c.open)} H${f(c.high)} L${f(c.low)} C${f(c.close)}`)
    .join('; ');
  return [
    `Mã: ${v.inst.name} (${v.symbol}). Giá hiện tại ${v.price}. Thay đổi 24h ${v.change24.toFixed(2)}%.`,
    `H4: xu hướng ${v.trendH4}, EMA20 ${f(v.ema20H4)}, EMA50 ${f(v.ema50H4)}. Vùng 5 ngày: hỗ trợ ${v.support}, kháng cự ${v.resistance}.`,
    `H1: EMA20 ${f(v.ema20H1)}, EMA50 ${f(v.ema50H1)}, RSI14 ${v.rsiH1.toFixed(1)}, ATR14 ${f(v.atrH1)} (${((v.atrH1 / v.price) * 100).toFixed(2)}%). Đỉnh/đáy 24h ${v.high24} / ${v.low24}.`,
    v.setup
      ? `Bộ quy tắc phát hiện: ${v.setup.title}. ${v.setup.reason}${v.setup.plan ? ` Kế hoạch gợi ý: vào ${f(v.setup.plan.entry)}, SL ${f(v.setup.plan.sl)}, TP1 ${f(v.setup.plan.tp1)}, TP2 ${f(v.setup.plan.tp2)}.` : ''}`
      : 'Bộ quy tắc chưa phát hiện điểm vào rõ ràng.',
    `24 nến H1 gần nhất (giờ UTC): ${candles}.`,
    'Hãy đánh giá có nên vào lệnh bây giờ không và đưa ra kế hoạch.',
  ].join('\n');
}

const numOrUndef = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);

/** Asks Gemini for an entry plan. Throws when no key / model is configured. */
export async function aiPlan(v: MarketView): Promise<AiPlan> {
  const [settings, key] = await Promise.all([loadAlertSettings(), loadGeminiKey()]);
  if (!key || !settings.model) throw new Error('Chưa có Gemini API key: vào Cài đặt → AI nhắc nhở vị thế.');
  const res = await generate(key, settings.model, SYSTEM, prompt(v), settings.models, true);
  // Plain-text fallback answers may wrap the JSON in prose or ``` fences: take the outer object.
  const start = res.text.indexOf('{');
  const end = res.text.lastIndexOf('}');
  let j: any;
  try {
    j = JSON.parse(res.text.slice(start, end + 1));
  } catch {
    throw new Error(`Gemini trả lời sai định dạng, thử lại. [${res.model.replace('models/', '')}]`);
  }
  const bias = j.bias === 'LONG' || j.bias === 'SHORT' ? j.bias : 'WAIT';
  return {
    bias,
    entryLow: numOrUndef(j.entryLow),
    entryHigh: numOrUndef(j.entryHigh),
    sl: numOrUndef(j.sl),
    tp1: numOrUndef(j.tp1),
    tp2: numOrUndef(j.tp2),
    confidence: Math.min(Math.max(Number(j.confidence) || 0, 0), 100),
    reason: String(j.reason ?? ''),
    risks: String(j.risks ?? ''),
    model: res.model,
    time: Date.now(),
  };
}

/** One-sentence comment for a background signal notification. */
export async function aiComment(v: MarketView): Promise<string | undefined> {
  const [settings, key] = await Promise.all([loadAlertSettings(), loadGeminiKey()]);
  if (!key || !settings.model || !settings.aiEnabled) return undefined;
  const res = await generate(
    key,
    settings.model,
    'Bạn là trợ lý giao dịch hàng hóa. Trả lời tiếng Việt, 2 câu ngắn (< 250 ký tự), không markdown: đánh giá tín hiệu có đáng vào không và lưu ý chính. Không bịa số liệu.',
    prompt(v),
    settings.models,
  );
  return res.text;
}
