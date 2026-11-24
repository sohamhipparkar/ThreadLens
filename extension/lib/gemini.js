// gemini.js — minimal Gemini REST client (works in the extension and in Node 18+).

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function friendly(status, body) {
  const msg = body?.error?.message || '';
  if (status === 400 && /API key/i.test(msg)) return 'Your Gemini API key looks invalid. Check it in Settings or .env.';
  if (status === 403) return 'Gemini refused the request (403). Is the API key enabled for the Generative Language API?';
  if (status === 404) return `Model not found. Check GEMINI_MODEL in Settings (${msg.slice(0, 120)}).`;
  if (status === 429) return 'Gemini rate limit reached. Wait a few seconds and try again.';
  return msg || `Gemini request failed (${status}).`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GeminiClient {
  constructor({ apiKey, model = 'gemini-3.8-flash', fetchImpl } = {}) {
    if (!apiKey) throw new GeminiError('No Gemini API key set. Add it to .env (then run setup) or paste it in Settings.', 401);
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.calls = 0;
    this.usage = { input: 0, output: 0 };
  }

  _body({ system, prompt, history = [], schema, json }) {
    const contents = [...history, { role: 'user', parts: [{ text: prompt }] }];
    const body = { contents, generationConfig: {} };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (json) {
      body.generationConfig.responseMimeType = 'application/json';
      if (schema) body.generationConfig.responseSchema = schema;
    }
    return body;
  }

  async _post(url, body, signal, attempt = 0) {
    this.calls++;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(800 * 2 ** attempt + Math.random() * 300);
      return this._post(url, body, signal, attempt + 1);
    }
    if (!res.ok) {
      let err = {};
      try { err = await res.json(); } catch { /* ignore */ }
      // Some models reject responseSchema — retry once with plain JSON mode.
      if (res.status === 400 && body.generationConfig?.responseSchema && /schema/i.test(err?.error?.message || '')) {
        const { responseSchema, ...rest } = body.generationConfig;
        return this._post(url, { ...body, generationConfig: rest }, signal, attempt);
      }
      throw new GeminiError(friendly(res.status, err), res.status);
    }
    return res;
  }

  _track(data) {
    const u = data?.usageMetadata;
    if (u) { this.usage.input += u.promptTokenCount || 0; this.usage.output += u.candidatesTokenCount || 0; }
  }

  static textOf(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  }

  /** Plain text generation. */
  async generate({ system, prompt, history, signal }) {
    const res = await this._post(`${BASE}/${this.model}:generateContent`, this._body({ system, prompt, history }), signal);
    const data = await res.json();
    this._track(data);
    const text = GeminiClient.textOf(data);
    if (!text) throw new GeminiError(blockReason(data), 502);
    return text;
  }

  /** JSON generation with schema; tolerant parsing. */
  async generateJSON({ system, prompt, schema, signal }) {
    const res = await this._post(`${BASE}/${this.model}:generateContent`, this._body({ system, prompt, schema, json: true }), signal);
    const data = await res.json();
    this._track(data);
    const text = GeminiClient.textOf(data);
    if (!text) throw new GeminiError(blockReason(data), 502);
    return parseJSONLoose(text);
  }

  /** Streaming text (SSE). Calls onToken(fullTextSoFar). Falls back to non-streaming on failure. */
  async stream({ system, prompt, history, onToken, signal }) {
    let res;
    try {
      res = await this._post(`${BASE}/${this.model}:streamGenerateContent?alt=sse`, this._body({ system, prompt, history }), signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const t = await this.generate({ system, prompt, history, signal });
      onToken?.(t);
      return t;
    }
    if (!res.body?.getReader) { const t = await this.generate({ system, prompt, history, signal }); onToken?.(t); return t; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const data = JSON.parse(line.slice(5).trim());
          this._track(data);
          const piece = GeminiClient.textOf(data);
          if (piece) { full += piece; onToken?.(full); }
        } catch { /* partial line */ }
      }
    }
    return full;
  }
}

function blockReason(data) {
  const r = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
  return r ? `Gemini returned no text (reason: ${r}).` : 'Gemini returned an empty response.';
}

export function parseJSONLoose(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new GeminiError('Model returned malformed JSON. Try again.', 502);
}
