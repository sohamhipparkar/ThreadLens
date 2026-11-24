// pipeline.js — the end-to-end flow:
// parse → redact (local) → plan (single pass or map-reduce) → extract → verify → restore

import { parseThread, renderMessages } from './parser.js';
import { Redactor, redactThread } from './privacy.js';
import { chunkMessages, estimateTokens } from './chunker.js';
import { EXTRACT_SYSTEM, EXTRACTION_SCHEMA, extractPrompt, REDUCE_SYSTEM, reducePrompt } from './prompts.js';
import { verifyResult } from './verify.js';

export const DEFAULT_SETTINGS = {
  model: 'gemini-3.8-flash',
  redactContacts: true,
  pseudonymizeNames: false,
  verifyWithLLM: true,
  singlePassTokenLimit: 1500,
  chunkTokens: 900,
  chunkOverlap: 1,
  concurrency: 3,
};

const STATUSES = ['open', 'done', 'blocked'];
const PRIORITIES = ['high', 'medium', 'low'];

/** Make model output safe to render: right shapes, valid IDs, sane enums. */
export function normalizeResult(raw, validIds) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ids = (arr) => (Array.isArray(arr) ? arr : [arr]).map((s) => String(s || '').trim().replace(/^\[|\]$/g, '').toUpperCase()).filter((s) => validIds.has(s));
  const list = (x) => (Array.isArray(x) ? x : []);
  return {
    tldr: String(r.tldr || '').trim(),
    summary: list(r.summary).filter((s) => s?.point).map((s) => ({ point: String(s.point).trim(), sources: ids(s.sources) })),
    decisions: list(r.decisions).filter((d) => d?.decision).map((d) => ({ decision: String(d.decision).trim(), sources: ids(d.sources) })),
    action_items: list(r.action_items).filter((a) => a?.task).map((a) => ({
      task: String(a.task).trim(),
      owner: String(a.owner || 'Unassigned').trim() || 'Unassigned',
      due: String(a.due || 'None').trim() || 'None',
      status: STATUSES.includes(String(a.status).toLowerCase()) ? String(a.status).toLowerCase() : 'open',
      priority: PRIORITIES.includes(String(a.priority).toLowerCase()) ? String(a.priority).toLowerCase() : 'medium',
      evidence: String(a.evidence || '').trim(),
      source: ids(a.source)[0] || '',
    })),
    open_questions: list(r.open_questions).filter((q) => q?.question).map((q) => ({ question: String(q.question).trim(), sources: ids(q.sources) })),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

function renderChunk(chunk) {
  return chunk.messages
    .map((m) => `[${m.id}]${m.contextOnly ? ' (context)' : ''} From: ${m.from}${m.date ? ` | Date: ${m.date}` : ''}\n${m.body}`)
    .join('\n\n---\n\n');
}

/**
 * analyzeThread(rawText, settings, { llm, onProgress, signal })
 * onProgress(stepKey, detail) — steps: parse, redact, plan, extract, reduce, verify, done
 */
export async function analyzeThread(rawText, settings = {}, { llm, onProgress = () => {}, signal } = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const t0 = Date.now();
  const callsBefore = llm?.calls || 0;

  // 1. Parse
  onProgress('parse', 'Splitting thread into messages');
  const thread = parseThread(rawText);
  if (!thread.messages.length || thread.stats.cleanChars < 20) throw new Error('That doesn’t look like an email thread — nothing to analyse.');
  onProgress('parse', `${thread.messages.length} messages · ${Math.round(thread.stats.quoteReduction * 100)}% quoted text removed`, true);

  // 2. Redact locally
  const redactor = new Redactor({ redactContacts: cfg.redactContacts, pseudonymizeNames: cfg.pseudonymizeNames });
  const safe = redactThread(thread, redactor);
  const privacy = redactor.report();
  onProgress('redact', privacy.total ? `${privacy.total} sensitive values masked before sending` : 'Nothing sensitive found', true);

  // 3. Plan
  const transcript = renderMessages(safe.messages);
  const tokens = estimateTokens(transcript);
  const chunks = tokens > cfg.singlePassTokenLimit ? chunkMessages(safe.messages, { chunkTokens: cfg.chunkTokens, overlap: cfg.chunkOverlap }) : null;
  const mode = chunks && chunks.length > 1 ? 'map-reduce' : 'single-pass';
  onProgress('plan', mode === 'map-reduce' ? `~${tokens} tokens → ${chunks.length} chunks (map-reduce)` : `~${tokens} tokens → single pass`, true);

  const validIds = new Set(safe.messages.map((m) => m.id));
  let extracted;

  // 4. Extract
  if (mode === 'single-pass') {
    onProgress('extract', 'Summarising and extracting action items');
    const raw = await llm.generateJSON({ system: EXTRACT_SYSTEM, prompt: extractPrompt({ subject: safe.subject, transcript }), schema: EXTRACTION_SCHEMA, signal });
    extracted = normalizeResult(raw, validIds);
    onProgress('extract', `${extracted.action_items.length} action items found`, true);
  } else {
    let done = 0;
    onProgress('extract', `Map: 0/${chunks.length} chunks`);
    const partials = await mapLimit(chunks, cfg.concurrency, async (chunk) => {
      const raw = await llm.generateJSON({ system: EXTRACT_SYSTEM, prompt: extractPrompt({ subject: safe.subject, transcript: renderChunk(chunk), partial: true }), schema: EXTRACTION_SCHEMA, signal });
      onProgress('extract', `Map: ${++done}/${chunks.length} chunks`);
      return { ids: chunk.ids, result: normalizeResult(raw, validIds) };
    });
    onProgress('extract', `${chunks.length} chunks processed`, true);
    onProgress('reduce', 'Merging partial results, resolving updates');
    const index = safe.messages.map((m) => `${m.id} — ${m.from}${m.date ? `, ${m.date}` : ''}`).join('\n');
    const raw = await llm.generateJSON({ system: REDUCE_SYSTEM, prompt: reducePrompt({ subject: safe.subject, partials, index }), schema: EXTRACTION_SCHEMA, signal });
    extracted = normalizeResult(raw, validIds);
    onProgress('reduce', `${extracted.action_items.length} action items after merge`, true);
  }

  // 5. Verify (against the full, redacted messages — independent of chunking)
  onProgress('verify', cfg.verifyWithLLM ? 'Checking every claim against its source email' : 'Checking quotes against source emails');
  const verification = await verifyResult(extracted, safe.messages, llm, { useJudge: cfg.verifyWithLLM, signal });
  onProgress('verify', `Faithfulness ${verification.score}%`, true);

  // 6. Restore placeholders for display (locally)
  const result = redactor.restore(extracted);

  onProgress('done', 'Done', true);
  return {
    subject: thread.subject,
    participants: thread.participants,
    messages: thread.messages,            // original (for the source viewer)
    safeMessages: safe.messages,          // redacted (what the model saw; used by chat)
    result,
    verification,
    redactor,
    stats: {
      ...thread.stats,
      tokens,
      mode,
      chunks: chunks ? chunks.length : 1,
      llmCalls: (llm?.calls || 0) - callsBefore,
      ms: Date.now() - t0,
      privacy,
      model: cfg.model,
    },
  };
}
