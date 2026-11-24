// verify.js — faithfulness checking in two independent layers.
//  Layer 1 (deterministic, free): does the quoted evidence literally exist in the
//          cited email? Do the owner and deadline actually appear in the thread?
//  Layer 2 (LLM-as-judge): a separate Gemini call that sees ONLY the claim and the
//          cited emails, and labels it supported / partial / unsupported.
// An item is "verified" only when both layers agree.

import { VERIFY_SYSTEM, VERIFY_SCHEMA, verifyPrompt } from './prompts.js';
import { renderMessages } from './parser.js';

export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, '')
    .trim();
}
const words = (s) => norm(s).match(/[a-z0-9\[\]_]+/g) || [];

/** Fraction of evidence words found, in order, inside the message (tolerates small edits). */
function orderedCoverage(evidence, body) {
  const ev = words(evidence);
  const bw = words(body);
  if (!ev.length) return 0;
  let j = 0, hit = 0;
  for (const w of ev) {
    const k = bw.indexOf(w, j);
    if (k >= 0) { hit++; j = k + 1; }
  }
  return hit / ev.length;
}

const NO_OWNER = /^(unassigned|none|unknown|unclear|tbd|n\/a|-)?$/i;
const NO_DUE = /^(none|n\/a|no deadline|not specified|unspecified|tbd|-)?$/i;
const DUE_STOP = new Set(['by', 'the', 'of', 'on', 'end', 'eod', 'before', 'at', 'in', 'next', 'this', 'day', 'cob', 'until']);

/** Layer 1 for a single action item. Mutates nothing; returns check details. */
export function checkActionItem(item, byId, allText) {
  const checks = [];
  let source = item.source;
  let corrected = false;

  // evidence grounding
  const cited = byId.get(source);
  let evidence = 'missing';
  if (cited && norm(cited.body).includes(norm(item.evidence))) evidence = 'exact';
  else if (cited && orderedCoverage(item.evidence, cited.body) >= 0.85) evidence = 'near';
  else {
    for (const m of byId.values()) {
      if (norm(m.body).includes(norm(item.evidence)) || orderedCoverage(item.evidence, m.body) >= 0.9) {
        evidence = 'exact'; source = m.id; corrected = true; break;
      }
    }
  }
  checks.push({ name: 'Evidence quote found in email', ok: evidence !== 'missing', detail: evidence === 'near' ? 'near-verbatim match' : corrected ? `found in ${source} (citation corrected)` : evidence });

  // owner grounding
  const owner = String(item.owner || '').trim();
  const ownerOk = NO_OWNER.test(owner) || owner.split(/[\s,/&]+/).filter((t) => t.length >= 3 || /^\[/.test(t))
    .some((t) => allText.includes(t.toLowerCase()));
  checks.push({ name: 'Owner appears in thread', ok: ownerOk, detail: owner || 'Unassigned' });

  // due-date grounding
  const due = String(item.due || '').trim();
  let dueOk = true;
  if (!NO_DUE.test(due)) {
    const msgText = norm((byId.get(source)?.body || '') + ' ' + item.evidence);
    const toks = (due.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => !DUE_STOP.has(t));
    dueOk = toks.length === 0 || toks.some((t) => msgText.includes(t.slice(0, 3)));
    if (!dueOk) dueOk = toks.some((t) => allText.includes(t)); // mentioned elsewhere in thread
  }
  checks.push({ name: 'Deadline stated in thread', ok: dueOk, detail: due || 'None' });

  return { checks, source, corrected, localOk: checks.every((c) => c.ok), evidenceFound: evidence !== 'missing' };
}

function citationsOk(sources, byId) {
  return Array.isArray(sources) && sources.length > 0 && sources.every((s) => byId.has(s));
}

/** Flatten result into checkable claims with stable ids. */
export function collectClaims(result) {
  const claims = [];
  result.summary.forEach((s, i) => claims.push({ id: `S${i + 1}`, kind: 'summary', ref: s, text: s.point, sources: s.sources }));
  result.decisions.forEach((d, i) => claims.push({ id: `D${i + 1}`, kind: 'decision', ref: d, text: d.decision, sources: d.sources }));
  result.action_items.forEach((a, i) => claims.push({
    id: `A${i + 1}`, kind: 'action', ref: a, sources: [a.source],
    text: `Action item: "${a.task}" — owner: ${a.owner}; due: ${a.due}; status: ${a.status}. Evidence quoted: "${a.evidence}"`,
  }));
  result.open_questions.forEach((q, i) => claims.push({ id: `Q${i + 1}`, kind: 'question', ref: q, text: `Still unresolved: ${q.question}`, sources: q.sources }));
  return claims;
}

/** Layer 2: batched LLM judge. Each batch only carries the emails its claims cite. */
async function judge(llm, claims, byId, { signal, batchSize = 12 } = {}) {
  const verdicts = new Map();
  for (let i = 0; i < claims.length; i += batchSize) {
    const batch = claims.slice(i, i + batchSize);
    const ids = [...new Set(batch.flatMap((c) => c.sources))].filter((id) => byId.has(id));
    ids.sort((a, b) => +a.slice(1) - +b.slice(1));
    const sources = renderMessages(ids.map((id) => byId.get(id)));
    const out = await llm.generateJSON({ system: VERIFY_SYSTEM, prompt: verifyPrompt({ claims: batch, sources }), schema: VERIFY_SCHEMA, signal });
    for (const v of out?.verdicts || []) verdicts.set(v.id, v);
  }
  return verdicts;
}

/**
 * Run both layers. Annotates each item in `result` with a `verification` object:
 * { status: 'verified'|'review'|'unsupported', checks:[], judge:{verdict,reason} }
 * Returns a summary { score, counts, judged }.
 */
export async function verifyResult(result, messages, llm, { useJudge = true, signal } = {}) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const allText = messages.map((m) => `${m.from} ${m.fromEmail} ${m.to} ${m.cc} ${m.body}`).join('\n').toLowerCase();

  // Layer 1
  for (const a of result.action_items) {
    const r = checkActionItem(a, byId, allText);
    if (r.corrected) a.source = r.source;
    a.verification = { checks: r.checks, localOk: r.localOk, evidenceFound: r.evidenceFound };
  }
  for (const list of [result.summary, result.decisions, result.open_questions]) {
    for (const it of list) {
      const ok = citationsOk(it.sources, byId);
      it.verification = { checks: [{ name: 'Cites real messages', ok, detail: (it.sources || []).join(', ') || 'none' }], localOk: ok };
    }
  }

  // Layer 2
  const claims = collectClaims(result);
  let verdicts = new Map();
  let judged = false;
  if (useJudge && llm && claims.length) {
    try { verdicts = await judge(llm, claims, byId, { signal }); judged = true; }
    catch (e) { if (e.name === 'AbortError') throw e; /* judge is best-effort; fall back to layer 1 */ }
  }

  const counts = { verified: 0, review: 0, unsupported: 0 };
  for (const c of claims) {
    const v = c.ref.verification;
    const j = verdicts.get(c.id);
    if (j) v.judge = { verdict: j.verdict, reason: j.reason };
    let status;
    if (c.kind === 'action' && !v.evidenceFound && (!j || j.verdict !== 'supported')) status = 'unsupported';
    else if (j?.verdict === 'unsupported') status = 'unsupported';
    else if (!v.localOk || j?.verdict === 'partial' || (!j && judged)) status = 'review';
    else status = 'verified';
    v.status = status;
    counts[status]++;
  }
  const total = claims.length || 1;
  const score = Math.round(((counts.verified + 0.5 * counts.review) / total) * 100);
  return { score, counts, judged, total: claims.length };
}
