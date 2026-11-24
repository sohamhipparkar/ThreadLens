// chunker.js — long-thread handling.
// Chunks are cut ONLY at message boundaries (never mid-email), so every chunk
// keeps whole messages with their IDs, and citations survive the map-reduce.

/** Cheap token estimate (~4 chars/token for English). Good enough for budgeting. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function messageTokens(m) {
  return estimateTokens(`[${m.id}] From: ${m.from} | Date: ${m.date}\n${m.body}`) + 4;
}

/**
 * Greedy packing of whole messages into chunks of <= chunkTokens.
 * `overlap` trailing messages of chunk k are repeated at the start of chunk k+1
 * (marked as context) so replies like "yes, I'll take that" keep their referent.
 * A single message larger than the budget is split by paragraphs as a last resort.
 */
export function chunkMessages(messages, { chunkTokens = 1500, overlap = 1 } = {}) {
  const units = [];
  for (const m of messages) {
    if (messageTokens(m) <= chunkTokens) { units.push(m); continue; }
    // oversized single email: split by paragraph, keep the same ID with a part suffix in metadata only
    const paras = m.body.split(/\n\s*\n/);
    let buf = [];
    let part = 1;
    const flush = () => {
      if (!buf.length) return;
      units.push({ ...m, body: buf.join('\n\n'), part: part++ });
      buf = [];
    };
    for (const p of paras) {
      if (estimateTokens([...buf, p].join('\n\n')) > chunkTokens * 0.9) flush();
      buf.push(p);
    }
    flush();
  }

  const chunks = [];
  let current = [];
  let tokens = 0;
  for (const u of units) {
    const t = messageTokens(u);
    if (current.length && tokens + t > chunkTokens) {
      chunks.push(current);
      const carry = overlap > 0 ? current.slice(-overlap).map((c) => ({ ...c, contextOnly: true })) : [];
      current = [...carry];
      tokens = carry.reduce((s, c) => s + messageTokens(c), 0);
    }
    current.push(u);
    tokens += t;
  }
  if (current.some((c) => !c.contextOnly)) chunks.push(current);

  return chunks.map((msgs, i) => ({
    index: i,
    messages: msgs,
    ids: msgs.filter((m) => !m.contextOnly).map((m) => m.id),
    tokens: msgs.reduce((s, m) => s + messageTokens(m), 0),
  }));
}

/** Simple BM25 retrieval over messages — used by the chatbot for very long threads. */
export function retrieve(messages, query, k = 8) {
  const tok = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
  const stop = new Set('the a an and or of to in on for is are was were be it this that with as at by from we you i he she they what who when where how did do does will can should about'.split(' '));
  const qTerms = [...new Set(tok(query).filter((t) => !stop.has(t)))];
  const docs = messages.map((m) => tok(`${m.from} ${m.body}`));
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, N);
  const df = Object.fromEntries(qTerms.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const t of qTerms) {
      const f = d.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
    }
    return { m: messages[i], score };
  });
  const top = scored.sort((a, b) => b.score - a.score).slice(0, k).filter((x) => x.score > 0).map((x) => x.m);
  // always include the latest message — it usually holds the current state
  const last = messages[messages.length - 1];
  if (last && !top.includes(last)) top.push(last);
  const order = new Map(messages.map((m, i) => [m.id, i]));
  return top.sort((a, b) => order.get(a.id) - order.get(b.id));
}
