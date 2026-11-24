// privacy.js — reversible, local-only redaction.
// Sensitive values are swapped for placeholders BEFORE anything leaves the
// browser, and swapped back only in the UI. The model never sees the originals.

const PATTERNS = [
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'CARD', re: /\b(?:\d[ -]?){13,16}\b/g, test: luhn },
  { type: 'AADHAAR', re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g },
  { type: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { type: 'PHONE', re: /(?<![\w-])(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{3,5}[ .-]?\d{3,4}[ .-]?\d{0,4}(?![\w-])/g, test: (s) => s.replace(/\D/g, '').length >= 10 },
  { type: 'IP', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { type: 'SECRET', re: /\b(?:sk|nsk|pk|rk|ghp|gho|xox[abp]|AKIA|AIza)[_-]?[A-Za-z0-9_-]{10,}\b/g },
  { type: 'SECRET', re: /\b(?:password|passcode|pwd|otp|pin|api[_ -]?key|key|token|secret)\b\s*(?:[:=]|\s(?:is|was))\s*["']?([^\s"',;]*\d[^\s"',;]*)/gi, group: 1, minLen: 6 },
];

function luhn(s) {
  const d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export class Redactor {
  /**
   * @param {{redactContacts?: boolean, pseudonymizeNames?: boolean}} opts
   */
  constructor(opts = {}) {
    this.opts = { redactContacts: true, pseudonymizeNames: false, ...opts };
    this.forward = new Map();  // original -> placeholder
    this.reverse = new Map();  // placeholder -> display original
    this.counters = {};
    this.nameRules = [];       // [{re, placeholder}]
  }

  _placeholder(type, original, display = original) {
    const key = `${type}:${original.toLowerCase()}`;
    if (this.forward.has(key)) return this.forward.get(key);
    this.counters[type] = (this.counters[type] || 0) + 1;
    const ph = `[${type}_${this.counters[type]}]`;
    this.forward.set(key, ph);
    this.reverse.set(ph, display);
    return ph;
  }

  /** Register participant names (from headers) so they can be pseudonymised consistently. */
  registerNames(people) {
    if (!this.opts.pseudonymizeNames) return;
    for (const p of people) {
      const full = (p.name || '').trim();
      if (!full || /@/.test(full) || full.length < 2) continue;
      const ph = this._placeholder('PERSON', full, full);
      const variants = new Set([full]);
      const parts = full.split(/\s+/);
      if (parts.length > 1 && parts[0].length >= 2) variants.add(parts[0]); // first name
      if (parts.length > 1 && parts[parts.length - 1].length >= 3) variants.add(parts[parts.length - 1]);
      for (const v of variants) this.nameRules.push({ re: new RegExp(`\\b${escapeRe(v)}\\b`, 'g'), placeholder: ph, len: v.length });
    }
    this.nameRules.sort((a, b) => b.len - a.len); // longest first
  }

  /** Redact one string. Safe to call repeatedly — placeholders are stable. */
  redact(text) {
    let out = String(text ?? '');
    if (this.opts.redactContacts) {
      for (const p of PATTERNS) {
        out = out.replace(p.re, (match, ...args) => {
          if (/^\[[A-Z]+_\d+\]$/.test(match)) return match;
          if (p.group) {
            const secret = args[p.group - 1];
            if (!secret || /^\[/.test(secret) || secret.length < (p.minLen || 4)) return match;
            return match.replace(secret, this._placeholder(p.type, secret));
          }
          if (p.test && !p.test(match)) return match;
          return this._placeholder(p.type, match.trim());
        });
      }
    }
    for (const r of this.nameRules) out = out.replace(r.re, r.placeholder);
    return out;
  }

  /** Restore placeholders in a string, or recursively in any JSON value. */
  restore(value) {
    if (typeof value === 'string') {
      return value.replace(/\[([A-Z]+)_(\d+)\]/g, (ph) => this.reverse.get(ph) ?? ph);
    }
    if (Array.isArray(value)) return value.map((v) => this.restore(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restore(v)]));
    }
    return value;
  }

  /** Summary of what was hidden — shown in the UI so the user can see privacy in action. */
  report() {
    const counts = {};
    for (const ph of this.reverse.keys()) {
      const type = ph.match(/^\[([A-Z]+)_/)[1];
      counts[type] = (counts[type] || 0) + 1;
    }
    return { total: this.reverse.size, counts };
  }
}

/** Redact a parsed thread (messages + headers) and return a new object. */
export function redactThread(thread, redactor) {
  redactor.registerNames(thread.participants);
  const messages = thread.messages.map((m) => ({
    ...m,
    from: redactor.redact(m.from),
    fromEmail: m.fromEmail ? redactor.redact(m.fromEmail) : '',
    to: redactor.redact(m.to || ''),
    cc: redactor.redact(m.cc || ''),
    body: redactor.redact(m.body),
  }));
  return { ...thread, subject: redactor.redact(thread.subject), messages };
}
