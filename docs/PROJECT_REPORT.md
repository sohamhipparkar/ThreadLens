# ThreadLens — Project Report

**PS 78 · Email Thread Summarizer & Action Tracker (Model Making)**
Final deliverable: a thread-to-summary-and-actions tool, built as a Chrome extension on Google Gemini.

---

## 1. Problem

Long email threads hide what matters: who owes what, by when, and what was decided. Readers skim, miss reassignments ("Vikram will take this over"), and act on stale information. A plain LLM summary does not fix this, because it can **hallucinate** owners or deadlines and cannot handle threads that are very long or full of quoted text. It also raises a **privacy** concern.

**Goal:** a tool that (a) summarises a thread, (b) extracts action items with owners, (c) proves each claim against the source, (d) scales to long threads, (e) protects personal data, and (f) presents results so a busy person can act on them.

## 2. Architecture

A Manifest V3 Chrome extension with a side panel. It has no backend server: the browser talks directly to the Gemini API, which keeps the data path short (Section 5).

```
Capture → Parse → Protect → Plan → Extract → Verify → Present (+ Chat)
```

| Stage | What happens | Why |
|---|---|---|
| Capture | Gmail DOM extraction (expands collapsed emails, removes quoted blocks), paste, right-click selection, samples | Works with real mail and offline demos |
| Parse | Split into emails `M1…Mn`, strip quoted history and signatures, de-duplicate, sort by date | Stable IDs make citations and verification possible; removes 70–80% of the text |
| Protect | Reversible on-device masking (`[EMAIL_1]`, `[PHONE_1]`, `[SECRET_1]`, optional `[PERSON_2]`) | Personal data never reaches the model |
| Plan | Token estimate → single pass, or map-reduce over email-boundary chunks | Long-thread handling |
| Extract | Gemini with a strict JSON schema; each item must carry a verbatim `evidence` quote and `source` ID | Structured output that can be checked |
| Verify | Layer 1: deterministic checks in code. Layer 2: independent Gemini fact-checker | Faithfulness |
| Present | Overview, Actions, Ask (chat), Emails tabs; clickable citations; export | Results you can act on and audit |

## 3. Summarisation and action-item extraction

The prompt (`extension/lib/prompts.js`) uses a JSON **response schema**, so output always parses. It contains:

- `tldr`, `summary[]`, `decisions[]` and `open_questions[]`, each with `sources: ["M3", …]`
- `action_items[]` with `task, owner, due, status (open|done|blocked), priority, evidence, source`

Key grounding rules:

- The owner is the person who committed to or was asked to do the task. If no one was, the owner is **"Unassigned"**, not a guess.
- The **latest state wins**: a later "done" closes a task, and a later reassignment changes the owner.
- Deadlines are copied exactly as written ("Nov 28", "Monday"). Nothing is converted or invented.
- `evidence` must be a 5–30 word verbatim quote.

Model output is then **normalised in code** (`normalizeResult`): invalid email IDs are dropped, enums are fixed, and missing fields get safe defaults. The UI never trusts raw model text.

## 4. Faithfulness: how we verify

We use two independent layers, and an item counts as verified only when both agree.

**Layer 1: deterministic (code, free, instant)**, in `verify.js`:
1. **Quote check:** the evidence quote must appear in the cited email (after normalising whitespace and quotes; near-verbatim allowed at ≥85% in-order word coverage).
2. **Citation repair:** if the quote is in a *different* email, the citation is corrected automatically.
3. **Owner check:** the owner must be a person named somewhere in the thread (or "Unassigned").
4. **Deadline check:** the deadline's words must appear in the cited email or the thread.

**Layer 2: LLM-as-judge.** A separate Gemini call acts as a strict fact-checker. It sees only the claim and the cited emails, not the whole thread or the first model's reasoning, and returns `supported / partial / unsupported` with a one-line reason. Claims are batched (12 per call) and each batch carries only the emails it cites, so this stays cheap even for long threads.

**Combining the layers:**
- ✅ **Verified:** Layer 1 passes and the judge says supported.
- ⚠️ **Needs review:** a Layer 1 check failed, or the judge says partial.
- ❌ **Unsupported:** the judge says unsupported, or the quote cannot be found anywhere and the judge does not support it.

**Faithfulness score** = (verified + ½ × needs-review) ÷ all claims, shown as the ring in the UI.

**Why two layers?** Code checks are exact but shallow: a real quote can still be paired with the wrong owner. The judge understands meaning but is itself a model. Together they catch both fabricated text and misattributed text. The user can always click a citation to see the highlighted source sentence, which is the final human check.

**Measuring the verifier:** `npm run eval` plants three false action items per thread (an invented task, a real quote with the wrong owner, and a real task with a wrong deadline) and reports how many the verifier catches.

## 5. Privacy

| Concern | What ThreadLens does |
|---|---|
| Personal data sent to an AI provider | Emails, phone numbers, Aadhaar, PAN, card numbers (Luhn-checked), IBAN, IP addresses, API keys/passwords/tokens are replaced on-device with placeholders before any request. Optional: participant names → `[PERSON_n]`. |
| Getting real values back | The placeholder map lives only in the side panel's memory; values are restored locally for display. |
| Storage | Thread content and results are held in memory only and disappear when the panel closes. Only settings (and the API key, if pasted) are saved, in `chrome.storage.local`. |
| Permissions | Reading only Gmail and Outlook pages, plus the Gemini API. Other sites only after an explicit permission prompt. No analytics, no third-party servers. |
| Transparency | The UI shows how many values were masked and what kind they were ("8 masked"). |

**Limits:** names of people who are not senders (e.g. a candidate mentioned in the body) are not masked without NER, and masking cannot hide the *meaning* of a confidential discussion. Data-handling terms differ between Gemini API tiers, so for real company mail use a paid Cloud project, review its data logging/storage settings, and follow your organisation's policy. An on-device model (e.g. Gemini Nano in Chrome) is the natural next step for fully local processing.

## 6. Long threads

1. **Quote stripping** removes "On … wrote:" blocks, `>` lines, "-----Original Message-----" blocks and signatures, then de-duplicates repeated emails. On the bundled samples this removed **74–77%** of the raw text.
2. **Token budget:** if the cleaned thread fits (`SINGLE_PASS_TOKEN_LIMIT`), one call is made.
3. **Map:** otherwise emails are packed greedily into chunks of `CHUNK_TOKENS`, **cut only at email boundaries**. The last email of each chunk is repeated at the start of the next one, marked `(context)`, so replies such as "yes, I'll take it" keep their meaning. An oversized single email is split by paragraph. Chunks run in parallel (3 at a time).
4. **Reduce:** a merge call combines the partial JSONs in chronological order. Later parts override earlier ones, duplicates are merged, and answered questions are removed. Quotes and IDs are copied, not rewritten.
5. **Verify on the full thread:** verification looks up the original emails by ID, so it does not depend on how the thread was chunked.
6. **Chat on long threads:** BM25 retrieval picks the ~10 most relevant emails plus the latest one.

Demo: the *Vendor outage (long)* sample has 26 emails, ~25k raw characters and ~1.9k tokens after cleaning, which become **3 chunks → merge**. Defaults are low on purpose so the demo shows chunking. Day-to-day, use ~8000/3000 tokens.

## 7. Results

- **Offline test suite:** `npm test` → 16/16 passing (parsing, masking round-trip, chunk coverage, fabricated-quote detection, citation repair, no private data in prompts, map-reduce path).
- **Pipeline statistics on the samples:**

| Sample | Emails | Raw chars | Quoted text removed | Mode | Values masked |
|---|---|---|---|---|---|
| Product launch | 10 | 8.9k | 74% | single pass | 6 (5 emails, 1 phone) |
| Vendor outage (long) | 26 | 25k | 77% | map-reduce, 3 chunks | 8 (7 emails, 1 API key) |
| Hiring loop | 5 | 3.7k | 75% | single pass | 6 (+4 names when pseudonymised) |

- **Model quality:** run `npm run eval` with your key. It writes `eval/results.md` with precision, recall, F1, owner/status accuracy, faithfulness score and planted-error detection per thread, scored against hand-labelled gold action items in `eval/gold/`. Paste that table here before presenting.

## 8. Limitations and future work

- Gmail extraction depends on Gmail's page structure and may need selector updates. Outlook web falls back to page text or a selection.
- Token counts are estimated (~4 chars/token). Gemini's `countTokens` endpoint could make them exact.
- Masking non-participant names needs NER.
- Next steps: push action items to Google Tasks, Calendar or Jira; "what changed since I last read" diffs; on-device model; multilingual threads.

## 9. Jury Q&A

**Q1. How do you verify faithfulness?** See Section 4. Every item carries a verbatim quote and an email ID, which code checks exactly. An independent Gemini fact-checker then judges each claim against only its cited emails, and an item is green only if both agree. The verifier is itself tested by planting false items.

**Q2. How do you handle very long threads?** See Section 6. Strip quotes, split at email boundaries with overlap, extract in parallel, merge chronologically, and verify against the full originals. Chat uses retrieval.

**Q3. Why not just use Gemini's 1M-token context?** Long contexts cost more, are slower, and recall details in the middle of the context less reliably. Chunking also keeps each call small enough for cheaper models and free-tier limits. The limit is configurable, so a team can choose.

**Q4. What if the model invents an owner?** The owner check fails if the name is not in the thread, and the judge flags it. The instructions also require "Unassigned" when nobody was clearly asked.

**Q5. How do you handle reassignments or completed tasks?** The prompt and reduce step apply "latest state wins", and the samples deliberately include both (Rahul → Vikram; "Re-copy is done").

**Q6. What does the model see? Is it safe?** Only the masked text (Section 5). Prompts in the test suite are asserted to contain no emails, keys or names when pseudonymisation is on.

**Q7. How did you evaluate it?** Hand-labelled gold action items for three threads. Matching uses task keywords; we report precision, recall on key items, owner and status accuracy, faithfulness score and planted-error detection.

**Q8. Why a Chrome extension?** It works where the email already is (Gmail) with zero copy-paste and no server to host or secure.

**Q9. What happens with bad or partial model output?** A JSON schema, tolerant parsing, code normalisation of IDs and enums, retries with backoff on 429/5xx, and clear error messages.

**Q10. What would you do with more time?** Exact token counting, NER-based name masking, an on-device model, and two-way sync with task trackers.

## 10. Three-minute demo script

1. Open the side panel and point out the privacy toggles. Load **Hiring loop** with *Pseudonymise names* on and analyse it: show "masked" in the header, then the **How was this checked?** section.
2. Load **Product launch** and analyse it. Walk through the TL;DR, then click a citation chip to show the highlighted source sentence. In **Actions**, point out Vikram (reassigned) and the done items. Expand evidence to show the checks and the AI fact-check.
3. Load **Vendor outage (long)**. The progress panel shows *77% quoted text removed → 3 chunks → merge*. Use the **Needs review** filter to show what the verifier flagged.
4. Open **Ask**: "What does Arjun still need to do?", then "Draft a follow-up email to the owners of open items." Point out the citations in the answers.
5. Export CSV and show the `eval/results.md` table.
