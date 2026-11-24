// prompts.js — every prompt and JSON schema in one place, so they are easy to audit.

const S = { type: 'STRING' };
const SOURCES = { type: 'ARRAY', items: S, description: 'Message IDs like "M3" that support this item' };

export const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    tldr: { type: 'STRING', description: 'One or two sentence overview of the thread' },
    summary: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { point: S, sources: SOURCES }, required: ['point', 'sources'] },
    },
    decisions: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { decision: S, sources: SOURCES }, required: ['decision', 'sources'] },
    },
    action_items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          task: S,
          owner: { type: 'STRING', description: 'Person responsible, exactly as named in the thread, or "Unassigned"' },
          due: { type: 'STRING', description: 'Deadline as written in the thread, or "None"' },
          status: { type: 'STRING', enum: ['open', 'done', 'blocked'] },
          priority: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'STRING', description: 'Short VERBATIM quote from the source message that shows this task' },
          source: { type: 'STRING', description: 'Message ID the evidence is quoted from, e.g. "M4"' },
        },
        required: ['task', 'owner', 'due', 'status', 'priority', 'evidence', 'source'],
      },
    },
    open_questions: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { question: S, sources: SOURCES }, required: ['question', 'sources'] },
    },
  },
  required: ['tldr', 'summary', 'decisions', 'action_items', 'open_questions'],
};

const GROUNDING_RULES = `Rules (follow strictly):
- Use ONLY information stated in the messages. Never guess names, dates or facts.
- Every item must cite the message ID(s) it comes from, e.g. "M3".
- "evidence" must be copied VERBATIM (exact characters) from the cited message, 5–30 words.
- Owner = the person who committed to or was explicitly asked to do the task. If nobody was clearly assigned, use "Unassigned".
- If a later message reassigns, completes or cancels a task, reflect the LATEST state (status "done" when someone confirms it is finished; drop cancelled tasks).
- due: copy the deadline as written ("Friday", "Nov 28", "EOD tomorrow"); "None" if not stated.
- priority: high if blocking / urgent / customer-facing deadline; low if nice-to-have; else medium.
- Placeholders like [EMAIL_1] or [PERSON_2] are privacy masks — keep them exactly as written.
- Be concise. Summary: 4–8 points, each one sentence.`;

export const EXTRACT_SYSTEM = `You are ThreadLens, a precise assistant that turns email threads into faithful summaries and action items.
${GROUNDING_RULES}`;

export function extractPrompt({ subject, transcript, partial }) {
  return `${partial ? 'This is ONE PART of a longer thread. Extract everything from this part only; messages marked (context) are repeated from the previous part for continuity — do not extract items that appear only in them.\n\n' : ''}Email thread subject: ${subject}

<thread>
${transcript}
</thread>

Return JSON with: tldr, summary, decisions, action_items, open_questions.`;
}

export const REDUCE_SYSTEM = `You merge partial extractions from consecutive parts of ONE long email thread into a single result.
- Parts are in chronological order; later parts override earlier ones (a task marked done later is done; a reassigned task gets the new owner).
- Merge duplicates (same task described twice) into one item; keep the most specific wording, keep the LATEST evidence quote and source unchanged (copy them exactly — never invent or edit quotes).
- Remove open questions that a later part answered.
- Keep message ID citations exactly as given.
- Summary: 5–8 points covering the whole thread, each citing sources. tldr: 1–2 sentences.
- Placeholders like [EMAIL_1] or [PERSON_2] are privacy masks — keep them.`;

export function reducePrompt({ subject, partials, index }) {
  return `Thread subject: ${subject}
Message index (ID, sender, date):
${index}

Partial extractions in order:
${partials.map((p, i) => `<part n="${i + 1}" messages="${p.ids.join(',')}">\n${JSON.stringify(p.result)}\n</part>`).join('\n')}

Return the merged JSON (tldr, summary, decisions, action_items, open_questions).`;
}

export const VERIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: S,
          verdict: { type: 'STRING', enum: ['supported', 'partial', 'unsupported'] },
          reason: { type: 'STRING', description: 'One short sentence; for partial/unsupported say what is wrong' },
        },
        required: ['id', 'verdict', 'reason'],
      },
    },
  },
  required: ['verdicts'],
};

export const VERIFY_SYSTEM = `You are a strict fact-checker. For each CLAIM decide whether the cited SOURCE messages support it.
- supported: every detail (who, what, when, status) is stated or directly implied by the sources.
- partial: the gist is right but a detail (owner, date, status, scope) is wrong, missing or over-stated.
- unsupported: the sources do not say this, or contradict it.
Judge ONLY against the provided sources, not general knowledge. Be skeptical: when in doubt choose partial.`;

export function verifyPrompt({ claims, sources }) {
  return `<sources>
${sources}
</sources>

<claims>
${claims.map((c) => `[${c.id}] (cites ${c.sources.join(', ') || 'nothing'}) ${c.text}`).join('\n')}
</claims>

Return {"verdicts":[{"id","verdict","reason"}]} with one verdict per claim id.`;
}

export const CHAT_SYSTEM = `You are ThreadLens Chat. You answer follow-up questions about ONE email thread.
- Answer ONLY from the thread and the extracted summary provided. If the answer is not in the thread, say "The thread doesn't say." and suggest who might know.
- Cite message IDs inline like [M4] after each fact.
- Be brief and direct: 1–5 sentences or a short list. Use plain Markdown (bold, lists) only when helpful.
- You may draft emails/replies or reword things when asked; base facts on the thread.
- Placeholders like [EMAIL_1] or [PERSON_2] are privacy masks — use them as-is, never guess the real values.`;
