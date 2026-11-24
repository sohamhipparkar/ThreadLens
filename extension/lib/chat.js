// chat.js — grounded follow-up Q&A over the analysed thread.
// Short threads: the whole (redacted) thread goes in the context.
// Long threads: BM25 retrieves the most relevant emails + the latest one.

import { CHAT_SYSTEM } from './prompts.js';
import { renderMessages } from './parser.js';
import { estimateTokens, retrieve } from './chunker.js';

export class ThreadChat {
  constructor({ llm, analysis, contextTokenLimit = 30000 }) {
    this.llm = llm;
    this.a = analysis;
    this.limit = contextTokenLimit;
    this.history = []; // Gemini-format turns (redacted space)
  }

  _summaryBlock() {
    // the summary the user sees, re-redacted so the model stays in placeholder space
    const r = this.a.redactor;
    const res = this.a.result;
    const lines = [
      `TL;DR: ${res.tldr}`,
      'Action items:',
      ...res.action_items.map((x, i) => `${i + 1}. ${x.task} — owner ${x.owner}, due ${x.due}, ${x.status} [${x.source}]`),
      'Decisions:', ...res.decisions.map((d) => `- ${d.decision} [${d.sources.join(', ')}]`),
      'Open questions:', ...res.open_questions.map((q) => `- ${q.question}`),
    ];
    return r.redact(lines.join('\n'));
  }

  _context(question) {
    const msgs = this.a.safeMessages;
    const full = renderMessages(msgs);
    if (estimateTokens(full) <= this.limit) return { text: full, scope: 'full thread' };
    const picked = retrieve(msgs, question, 10);
    return { text: renderMessages(picked), scope: `${picked.length} most relevant of ${msgs.length} emails` };
  }

  async ask(question, { onToken, signal } = {}) {
    const r = this.a.redactor;
    const safeQ = r.redact(question);
    const ctx = this._context(safeQ);
    const prompt = `Thread subject: ${r.redact(this.a.subject)}
<extracted_summary>
${this._summaryBlock()}
</extracted_summary>
<thread scope="${ctx.scope}">
${ctx.text}
</thread>

Question: ${safeQ}`;
    const answer = await this.llm.stream({
      system: CHAT_SYSTEM,
      prompt,
      history: this.history.slice(-8),
      signal,
      onToken: (t) => onToken?.(r.restore(t)),
    });
    // store a compact history (question only, not the big context) to keep follow-ups cheap
    this.history.push({ role: 'user', parts: [{ text: safeQ }] }, { role: 'model', parts: [{ text: answer }] });
    return { answer: r.restore(answer), scope: ctx.scope };
  }

  reset() { this.history = []; }
}
