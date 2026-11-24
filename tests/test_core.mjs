// Offline tests for the core pipeline (no API key needed). Run: node tests/test_core.mjs
import fs from 'fs';
import assert from 'assert/strict';
import { parseThread, cleanBody } from '../extension/lib/parser.js';
import { Redactor, redactThread } from '../extension/lib/privacy.js';
import { chunkMessages, retrieve } from '../extension/lib/chunker.js';
import { analyzeThread, normalizeResult } from '../extension/lib/pipeline.js';
import { checkActionItem } from '../extension/lib/verify.js';

const sample = (f) => fs.readFileSync(new URL(`../extension/samples/${f}`, import.meta.url), 'utf8');
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log('Parser');
await test('splits Gmail-style thread into 10 ordered messages', () => {
  const t = parseThread(sample('product_launch.txt'));
  assert.equal(t.messages.length, 10);
  assert.equal(t.messages[0].from, 'Priya Sharma');
  assert.equal(t.messages[9].id, 'M10');
});
await test('removes quoted history (>70% of raw text)', () => {
  const t = parseThread(sample('vendor_escalation_long.txt'));
  assert.equal(t.messages.length, 26);
  assert.ok(t.stats.quoteReduction > 0.7, `reduction ${t.stats.quoteReduction}`);
  assert.ok(!t.messages.some((m) => /Original Message/.test(m.body)));
});
await test('cleanBody strips "On … wrote:" blocks and signatures', () => {
  assert.equal(cleanBody('Sounds good.\n\nOn Mon, Nov 2, 2026, A <a@x.com> wrote:\n> old text'), 'Sounds good.');
  assert.equal(cleanBody('Done.\n--\nJane Doe\nCEO'), 'Done.');
});
await test('plain text without headers becomes one message', () => {
  const t = parseThread('Can you send the report by Friday? Thanks, Alex');
  assert.equal(t.messages.length, 1);
});
await test('reorders newest-first threads to chronological', () => {
  const raw = 'From: B <b@x.com>\nDate: Tue, 3 Nov 2026 10:00\nSubject: Hi\n\nSecond\n\nFrom: A <a@x.com>\nDate: Mon, 2 Nov 2026 10:00\nSubject: Hi\n\nFirst';
  const t = parseThread(raw);
  assert.equal(t.messages[0].body, 'First');
  assert.ok(t.stats.reordered);
});

console.log('Privacy');
await test('masks emails, phones and secrets, and restores them', () => {
  const r = new Redactor({ redactContacts: true });
  const s = r.redact('Mail riya@example.com or call +91 99887 66554. Old key was nsk_live_8f2a9c71d4.');
  assert.ok(!/example\.com|99887|8f2a9c/.test(s), s);
  assert.equal(r.restore(s), 'Mail riya@example.com or call +91 99887 66554. Old key was nsk_live_8f2a9c71d4.');
});
await test('pseudonymises participant names consistently (full and first name)', () => {
  const t = parseThread(sample('hiring_loop.txt'));
  const r = new Redactor({ pseudonymizeNames: true });
  const safe = redactThread(t, r);
  const all = safe.messages.map((m) => m.from + ' ' + m.body).join(' ');
  assert.ok(!/Fatima|Ishaan|Karan/.test(all), 'names leaked');
  assert.deepEqual(r.restore({ owner: '[PERSON_1]' }), { owner: 'Fatima Ali' });
});
await test('does not mask dates or amounts', () => {
  const r = new Redactor();
  assert.equal(r.redact('Due 2026-11-28, budget $3,500 per month'), 'Due 2026-11-28, budget $3,500 per month');
});

console.log('Chunking');
await test('chunks only at message boundaries, with overlap as context', () => {
  const t = parseThread(sample('vendor_escalation_long.txt'));
  const chunks = chunkMessages(t.messages, { chunkTokens: 900, overlap: 1 });
  assert.ok(chunks.length >= 2);
  const covered = chunks.flatMap((c) => c.ids);
  assert.deepEqual(covered, t.messages.map((m) => m.id)); // every message exactly once
  assert.ok(chunks[1].messages[0].contextOnly);
});
await test('retrieval finds the right emails for a question', () => {
  const t = parseThread(sample('vendor_escalation_long.txt'));
  const hits = retrieve(t.messages, 'SLA credit claim reference', 3).map((m) => m.id);
  assert.ok(hits.includes('M23'), hits.join(','));
});

console.log('Faithfulness');
const launch = parseThread(sample('product_launch.txt'));
const byId = new Map(launch.messages.map((m) => [m.id, m]));
const allText = launch.messages.map((m) => `${m.from} ${m.body}`).join(' ').toLowerCase();
await test('accepts a correctly quoted action item', () => {
  const r = checkActionItem({ task: 'Fix crash', owner: 'Rahul Mehta', due: 'Nov 27', evidence: "I'll fix the Android 12 login crash by Nov 27", source: 'M7' }, byId, allText);
  assert.ok(r.localOk, JSON.stringify(r.checks));
});
await test('flags a fabricated quote and an invented owner', () => {
  const r = checkActionItem({ task: 'Order pizza', owner: 'Bob Smith', due: 'None', evidence: 'Bob will order pizza for the launch party', source: 'M3' }, byId, allText);
  assert.equal(r.evidenceFound, false);
  assert.equal(r.checks[1].ok, false);
});
await test('corrects a wrong citation when the quote exists in another email', () => {
  const r = checkActionItem({ task: 'x', owner: 'Priya Sharma', due: 'None', evidence: "I'll send the invite today", source: 'M1' }, byId, allText);
  assert.equal(r.source, 'M10');
});
await test('normalizeResult drops invalid citations and fixes enums', () => {
  const n = normalizeResult({ tldr: 't', summary: [{ point: 'p', sources: ['M1', 'M99', '[M2]'] }], action_items: [{ task: 'x', status: 'DONE', priority: 'urgent', source: 'M3' }] }, new Set(['M1', 'M2', 'M3']));
  assert.deepEqual(n.summary[0].sources, ['M1', 'M2']);
  assert.equal(n.action_items[0].status, 'done');
  assert.equal(n.action_items[0].priority, 'medium');
});

console.log('Pipeline (mock LLM)');
class MockLLM {
  constructor() { this.calls = 0; this.prompts = []; }
  async generateJSON({ system, prompt }) {
    this.calls++; this.prompts.push(prompt);
    if (/fact-checker/.test(system)) {
      const ids = [...prompt.matchAll(/^\[([SDAQ]\d+)\]/gm)].map((m) => m[1]);
      return { verdicts: ids.map((id) => ({ id, verdict: 'supported', reason: 'ok' })) };
    }
    const id = (prompt.match(/\[(M\d+)\]/) || [])[1] || 'M1';
    return { tldr: 'Mock', summary: [{ point: 'Something happened', sources: [id] }], decisions: [], open_questions: [],
      action_items: [{ task: 'Rotate key', owner: '[PERSON_3]', due: 'Nov 10', status: 'done', priority: 'high', evidence: 'Service account key rotated', source: 'M22' }] };
  }
}
await test('long thread goes through map-reduce and nothing private leaks', async () => {
  const llm = new MockLLM();
  const out = await analyzeThread(sample('vendor_escalation_long.txt'), { singlePassTokenLimit: 1500, chunkTokens: 900, pseudonymizeNames: true }, { llm });
  assert.equal(out.stats.mode, 'map-reduce');
  assert.ok(out.stats.chunks >= 2);
  const sent = llm.prompts.join('\n');
  assert.ok(!/@corvid-analytics|nsk_live|Arjun Patel/.test(sent), 'private data reached the model');
  assert.equal(out.result.action_items[0].owner, 'Arjun Patel'); // restored locally
  assert.equal(out.result.action_items[0].verification.status, 'verified');
});
await test('short thread uses a single pass', async () => {
  const llm = new MockLLM();
  const out = await analyzeThread(sample('hiring_loop.txt'), {}, { llm });
  assert.equal(out.stats.mode, 'single-pass');
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}.`);
