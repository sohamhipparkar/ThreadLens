// parser.js — turns a raw email thread (pasted text or extracted from Gmail)
// into a clean, ordered list of messages with stable IDs (M1, M2, ...).
// Stable IDs are what make citations and faithfulness checks possible.

const HEADER_KEYS = ['from', 'to', 'cc', 'bcc', 'date', 'sent', 'subject'];

// Lines that mark the start of quoted history inside a reply.
const QUOTE_MARKERS = [
  /^On .{4,200}wrote:\s*$/i,                         // Gmail / Apple Mail
  /^On .{4,120}$/i,                                   // wrapped "On ... \n X wrote:" (checked with next line)
  /^-{2,}\s*Original Message\s*-{2,}/i,               // Outlook
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^_{8,}\s*$/,                                       // Outlook separator line
  /^From:\s.+$/i,                                     // inline quoted header
];

const SIGNATURE_MARKERS = [
  /^--\s*$/,
  /^Sent from my (iPhone|iPad|Android|phone|mobile)/i,
  /^Get Outlook for (iOS|Android)/i,
  /^This (e-?mail|message) (and any attachments )?(is|may be) confidential/i,
];

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
}

/** Remove quoted history and signatures from a single message body. */
export function cleanBody(body) {
  const lines = normalizeNewlines(body).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith('>')) continue; // classic quoted line
    if (/^On .{4,200}wrote:\s*$/i.test(t)) break;
    if (/^On .{4,160}$/i.test(t) && /wrote:\s*$/i.test((lines[i + 1] || '').trim())) break;
    if (QUOTE_MARKERS.slice(2).some((re) => re.test(t))) break;
    if (SIGNATURE_MARKERS.some((re) => re.test(t))) break;
    out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Parse "Name <email>" into parts. */
export function parsePerson(raw) {
  const s = String(raw || '').trim().replace(/^"|"$/g, '');
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  if (/@/.test(s)) return { name: s.split('@')[0], email: s };
  return { name: s, email: '' };
}

function isHeaderLine(line) {
  const m = line.match(/^([A-Za-z]+):\s?(.*)$/);
  return m && HEADER_KEYS.includes(m[1].toLowerCase()) ? { key: m[1].toLowerCase(), value: m[2].trim() } : null;
}

/**
 * Find message boundaries: a "From:" line at the very start or after a blank
 * line / separator, followed within 6 lines by another header (Date/Sent/To/Subject).
 * Quoted "From:" lines inside replies are already stripped by cleanBody later,
 * and quoted lines prefixed with ">" never match.
 */
function findBoundaries(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^From:\s*\S/i.test(lines[i].trim()) || lines[i].startsWith('>')) continue;
    const prev = i === 0 ? '' : lines[i - 1].trim();
    const prevOk = i === 0 || prev === '' || /^[-=_*]{3,}$/.test(prev) || /^#{1,3}\s/.test(prev);
    let hasOtherHeader = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      const h = isHeaderLine(lines[j].trim());
      if (h && h.key !== 'from') { hasOtherHeader = true; break; }
      if (lines[j].trim() === '') break;
    }
    if (prevOk && hasOtherHeader) starts.push(i);
  }
  return starts;
}

/**
 * parseThread(raw) -> { subject, messages: [{id, from, fromEmail, to, date, subject, body, raw}] , stats }
 */
export function parseThread(raw) {
  const text = normalizeNewlines(raw).trim();
  const lines = text.split('\n');
  let subject = '';
  const subjLine = lines.find((l) => /^Subject:\s*\S/i.test(l.trim()));
  if (subjLine) subject = subjLine.trim().replace(/^Subject:\s*/i, '').replace(/^(re|fw|fwd):\s*/gi, '').trim();

  // Quoted copies of earlier messages that get split out are removed by the de-duplication step below.
  const starts = findBoundaries(lines);
  let messages = [];

  if (starts.length === 0) {
    messages.push({ from: 'Unknown', fromEmail: '', to: '', date: '', subject, rawBody: text });
  } else {
    for (let k = 0; k < starts.length; k++) {
      const block = lines.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : lines.length);
      const headers = {};
      let b = 0;
      for (; b < block.length; b++) {
        const t = block[b].trim();
        if (t === '') { b++; break; }
        const h = isHeaderLine(t);
        if (h) headers[h.key] = h.value;
        else if (Object.keys(headers).length && b < 8) continue; // wrapped header line
        else break;
      }
      const person = parsePerson(headers.from);
      // trailing separator lines between messages
      const bodyLines = block.slice(b).filter((l, idx, arr) => !(idx === arr.length - 1 && /^[-=_*]{3,}$/.test(l.trim())));
      messages.push({
        from: person.name,
        fromEmail: person.email,
        to: headers.to || '',
        cc: headers.cc || '',
        date: headers.date || headers.sent || '',
        subject: (headers.subject || subject).replace(/^((re|fw|fwd):\s*)+/gi, '').trim(),
        rawBody: bodyLines.join('\n'),
      });
    }
  }

  // Chronological order: if dates parse and the first is later than the last, reverse (Outlook newest-first).
  const t0 = Date.parse(messages[0]?.date);
  const tN = Date.parse(messages[messages.length - 1]?.date);
  let reordered = false;
  if (messages.length > 1 && !isNaN(t0) && !isNaN(tN) && t0 > tN) { messages.reverse(); reordered = true; }

  const rawChars = text.length;
  const seen = new Set();
  let duplicatesRemoved = 0;
  messages = messages
    .map((m) => ({ ...m, body: cleanBody(m.rawBody) }))
    .filter((m) => {
      const key = m.body.replace(/\s+/g, ' ').toLowerCase();
      if (!key) { duplicatesRemoved++; return false; }
      if (seen.has(key)) { duplicatesRemoved++; return false; }
      seen.add(key);
      return true;
    })
    .map((m, i) => ({ id: `M${i + 1}`, from: m.from, fromEmail: m.fromEmail, to: m.to, cc: m.cc, date: m.date, subject: m.subject, body: m.body }));

  if (!subject && messages[0]?.subject) subject = messages[0].subject;
  const cleanChars = messages.reduce((s, m) => s + m.body.length, 0);

  return {
    subject: subject || 'Untitled thread',
    messages,
    participants: participantsOf(messages),
    stats: { rawChars, cleanChars, messageCount: messages.length, duplicatesRemoved, reordered,
      quoteReduction: rawChars ? Math.max(0, 1 - cleanChars / rawChars) : 0 },
  };
}

export function participantsOf(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = (m.fromEmail || m.from).toLowerCase();
    if (!map.has(key)) map.set(key, { name: m.from, email: m.fromEmail, count: 0 });
    map.get(key).count++;
  }
  return [...map.values()];
}

/** Render messages in the canonical, ID-tagged format the model sees. */
export function renderMessages(messages) {
  return messages
    .map((m) => `[${m.id}] From: ${m.from}${m.date ? ` | Date: ${m.date}` : ''}\n${m.body}`)
    .join('\n\n---\n\n');
}
