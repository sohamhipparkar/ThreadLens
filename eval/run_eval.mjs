// Evaluation harness — runs the real pipeline (real Gemini calls) on the sample threads
// and measures: action-item precision/recall, owner & status accuracy, faithfulness,
// and how many deliberately planted false claims the verifier catches.
//
// Usage:  node eval/run_eval.mjs            (needs GEMINI_API_KEY in .env)
// Output: printed table + eval/results.md

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GeminiClient } from '../extension/lib/gemini.js';
import { analyzeThread, DEFAULT_SETTINGS } from '../extension/lib/pipeline.js';
import { verifyResult } from '../extension/lib/verify.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  (fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '')
    .split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
env.GEMINI_API_KEY ||= process.env.GEMINI_API_KEY;
if (!env.GEMINI_API_KEY) { console.error('Add GEMINI_API_KEY to .env first.'); process.exit(1); }

const settings = {
  ...DEFAULT_SETTINGS,
  model: env.GEMINI_MODEL || DEFAULT_SETTINGS.model,
  singlePassTokenLimit: +env.SINGLE_PASS_TOKEN_LIMIT || DEFAULT_SETTINGS.singlePassTokenLimit,
  chunkTokens: +env.CHUNK_TOKENS || DEFAULT_SETTINGS.chunkTokens,
  pseudonymizeNames: false,
};

const UNASSIGNED = /unassigned|none|all|every|team|interviewers|someone/i;
const lc = (s) => String(s || '').toLowerCase();

function match(pred, gold) {
  const used = new Set();
  const pairs = [];
  for (const g of gold) {
    let best = -1, bestScore = 0;
    pred.forEach((p, i) => {
      if (used.has(i)) return;
      const hit = g.keywords.filter((k) => lc(p.task).includes(k)).length / g.keywords.length;
      if (hit > bestScore) { bestScore = hit; best = i; }
    });
    if (best >= 0 && bestScore >= 0.5) { used.add(best); pairs.push({ g, p: pred[best] }); }
  }
  return { pairs, used };
}

function ownerOk(p, g) {
  return g.owner === 'Unassigned' ? UNASSIGNED.test(p.owner) : lc(p.owner).includes(lc(g.owner));
}

async function plantedTest(analysis, llm) {
  const msgs = analysis.safeMessages;
  const people = analysis.participants.map((x) => x.name);
  const real = analysis.result.action_items.find((a) => a.verification?.status === 'verified') || analysis.result.action_items[0];
  if (!real) return { planted: 0, caught: 0 };
  const other = people.find((n) => !lc(real.owner).includes(lc(n).split(' ')[0])) || 'Someone Else';
  const planted = [
    { task: 'Book an offsite venue for the team', owner: people[0], due: 'None', status: 'open', priority: 'low', evidence: 'please book an offsite venue for the whole team', source: msgs[0].id },
    { ...real, owner: other, verification: undefined },                        // wrong owner, real quote
    { ...real, due: 'Dec 25', status: 'open', verification: undefined },       // wrong deadline
  ].map((a) => analysis.redactor.redact ? JSON.parse(analysis.redactor.redact(JSON.stringify(a))) : a);
  const fake = { tldr: '', summary: [], decisions: [], open_questions: [], action_items: planted };
  await verifyResult(fake, msgs, llm, { useJudge: settings.verifyWithLLM });
  const caught = fake.action_items.filter((a) => a.verification.status !== 'verified').length;
  return { planted: planted.length, caught, detail: fake.action_items.map((a) => a.verification.status) };
}

const rows = [];
for (const f of fs.readdirSync(path.join(ROOT, 'eval/gold'))) {
  const gold = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/gold', f), 'utf8'));
  const raw = fs.readFileSync(path.join(ROOT, 'extension/samples', gold.sample), 'utf8');
  const llm = new GeminiClient({ apiKey: env.GEMINI_API_KEY, model: settings.model });
  process.stdout.write(`▶ ${gold.sample} … `);
  const a = await analyzeThread(raw, settings, { llm });
  const pred = a.result.action_items;
  const required = gold.action_items.filter((g) => !g.optional);
  const { pairs: reqPairs } = match(pred, required);
  const { pairs: allPairs, used } = match(pred, gold.action_items);
  const precision = pred.length ? used.size / pred.length : 0;
  const recall = required.length ? reqPairs.length / required.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const owner = allPairs.length ? allPairs.filter(({ p, g }) => ownerOk(p, g)).length / allPairs.length : 0;
  const status = allPairs.length ? allPairs.filter(({ p, g }) => (p.status === 'done') === (g.status === 'done')).length / allPairs.length : 0;
  const planted = await plantedTest(a, llm);
  const missed = required.filter((g) => !reqPairs.some((x) => x.g === g)).map((g) => g.keywords.join(' '));
  rows.push({ sample: gold.sample, emails: a.stats.messageCount, mode: a.stats.mode === 'map-reduce' ? `map-reduce (${a.stats.chunks})` : 'single', predicted: pred.length,
    precision, recall, f1, owner, status, faithfulness: a.verification.score, unsupported: a.verification.counts.unsupported,
    planted: `${planted.caught}/${planted.planted}`, calls: a.stats.llmCalls, secs: (a.stats.ms / 1000).toFixed(1), missed });
  console.log(`done (${a.stats.ms} ms)`);
}

const pct = (x) => `${Math.round(x * 100)}%`;
const table = [
  '| Thread | Emails | Mode | Items | Precision | Recall (key items) | F1 | Owner acc. | Status acc. | Faithfulness | Planted errors caught | Calls | Time |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.sample} | ${r.emails} | ${r.mode} | ${r.predicted} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} | ${pct(r.owner)} | ${pct(r.status)} | ${r.faithfulness}% | ${r.planted} | ${r.calls} | ${r.secs}s |`),
].join('\n');
const notes = rows.filter((r) => r.missed.length).map((r) => `- ${r.sample}: missed ${r.missed.join('; ')}`).join('\n') || '- No required items missed.';
const md = `# ThreadLens evaluation\n\nModel: \`${settings.model}\` · run ${new Date().toISOString()}\n\n${table}\n\n**Definitions** — Precision: share of extracted items that match a labelled task. Recall: share of the key (open/critical) labelled tasks found. Owner/Status accuracy: on matched items. Faithfulness: verified claims (+½ for "needs review") over all claims. Planted errors: three false action items (invented task, wrong owner, wrong deadline) injected after extraction — counted as caught if the verifier does not mark them "verified".\n\n**Missed items**\n${notes}\n`;
fs.writeFileSync(path.join(ROOT, 'eval/results.md'), md);
console.log('\n' + table + '\n\nSaved eval/results.md');
