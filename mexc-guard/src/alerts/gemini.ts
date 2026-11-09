// Minimal Gemini REST client (Generative Language API, v1beta).

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 25_000;

class GeminiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Readable Vietnamese message for the usual API failures. */
function explain(status: number, raw: string) {
  if (status === 503) return 'Model đang quá tải (Google báo nhiều người dùng)';
  if (status === 429) return 'Hết hạn mức gọi của key (thử lại sau hoặc đổi model)';
  if (status === 400 && /API key/i.test(raw)) return 'API key không hợp lệ';
  if (status === 403) return 'Key không có quyền dùng Gemini API';
  if (status === 404) return 'Model không còn tồn tại';
  return raw || `Gemini HTTP ${status}`;
}

async function call(path: string, key: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, ...(init.headers ?? {}) },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new GeminiError(explain(res.status, json?.error?.message ?? ''), res.status);
    return json;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new GeminiError('Gemini quá thời gian phản hồi', 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type ModelFamily = 'flash' | 'pro' | 'other';

export interface GeminiModel {
  name: string;
  displayName: string;
  family: ModelFamily;
  preview: boolean;
}

export const familyOf = (name: string): ModelFamily => (/flash/i.test(name) ? 'flash' : /pro/i.test(name) ? 'pro' : 'other');
const isPreview = (name: string) => /preview|exp|latest/i.test(name);
const version = (n: string) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0');

/**
 * Text models the key can use for generateContent. Sorted: stable before preview, then Flash,
 * Flash-Lite, Pro, others, newest version first — the first one is the sensible default.
 */
export async function listModels(key: string): Promise<GeminiModel[]> {
  const out: GeminiModel[] = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const json = await call(`models?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`, key);
    for (const m of json?.models ?? []) {
      const name = String(m.name ?? '');
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
      // Only general text models: skip image / audio / embedding / live and other special ones.
      if (!/gemini/i.test(name) || /image|tts|audio|live|embed|vision|learnlm|robotics|computer|native/i.test(name)) continue;
      out.push({ name, displayName: String(m.displayName ?? name.replace('models/', '')), family: familyOf(name), preview: isPreview(name) });
    }
    pageToken = json?.nextPageToken ?? '';
    if (!pageToken) break;
  }
  const kind = (n: string) => (/flash-lite/i.test(n) ? 1 : /flash/i.test(n) ? 0 : /pro/i.test(n) ? 2 : 3);
  return out.sort(
    (a, b) => Number(a.preview) - Number(b.preview) || kind(a.name) - kind(b.name) || version(b.name) - version(a.name),
  );
}

async function generateOnce(key: string, model: string, system: string, prompt: string, jsonMode = false): Promise<string> {
  const json = await call(`${model}:generateContent`, key, {
    method: 'POST',
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        // Thinking models spend part of this budget before answering.
        maxOutputTokens: 8192,
        ...(jsonMode && { responseMimeType: 'application/json' }),
      },
    }),
  });
  const text = (json?.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string; thought?: boolean }) => (p.thought ? '' : (p.text ?? '')))
    .join('')
    .trim();
  if (!text) {
    const reason = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason;
    throw new GeminiError(reason ? `Gemini không trả lời (${reason})` : 'Gemini không trả lời', 200);
  }
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Overloaded / rate-limited / timed out / gone: worth retrying or moving to another model. */
const transient = (e: unknown) => e instanceof GeminiError && [429, 500, 503, 504].includes(e.status);
/** Empty answer (blocked / ran out of tokens) or model gone: try the next model. */
const switchable = (e: unknown) => transient(e) || (e instanceof GeminiError && (e.status === 404 || e.status === 200));
/** The model rejected or fumbled JSON mode: worth one retry in plain text mode. */
const jsonTrouble = (e: unknown) =>
  e instanceof GeminiError && (e.status === 200 || (e.status === 400 && /mime|json|schema/i.test(e.message)));

/**
 * Generates with `model`, retrying overloads with backoff, then falling back to the other models
 * (same family first). Returns the text and the model that answered.
 */
export async function generate(
  key: string,
  model: string,
  system: string,
  prompt: string,
  fallbacks: string[] = [],
  json = false,
): Promise<{ text: string; model: string }> {
  const fam = familyOf(model);
  const chain = [
    model,
    ...fallbacks.filter((m) => m !== model && familyOf(m) === fam && !isPreview(m)),
    ...fallbacks.filter((m) => m !== model && familyOf(m) !== fam && !isPreview(m)),
  ].slice(0, 4);
  let lastError: unknown = null;
  let lastModel = model;
  for (const [i, m] of chain.entries()) {
    // The chosen model gets two retries; fallbacks one attempt each.
    const attempts = i === 0 ? 3 : 1;
    let jsonMode = json;
    for (let a = 0; a < attempts; a++) {
      try {
        return { text: await generateOnce(key, m, system, prompt, jsonMode), model: m };
      } catch (e) {
        lastError = e;
        lastModel = m;
        // JSON mode trouble: retry this model once in plain mode (the prompt still asks for JSON).
        if (jsonMode && jsonTrouble(e)) {
          jsonMode = false;
          a--;
          continue;
        }
        if (!switchable(e)) break;
        if (transient(e) && a < attempts - 1) await sleep(1500 * (a + 1));
        else break;
      }
    }
    if (!switchable(lastError)) break;
  }
  const msg = lastError instanceof Error ? lastError.message : 'Gemini lỗi';
  throw new Error(`${msg} [${lastModel.replace('models/', '')}]`);
}
