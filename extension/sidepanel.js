// sidepanel.js — UI controller for ThreadLens.
import { GeminiClient } from './lib/gemini.js';
import { analyzeThread } from './lib/pipeline.js';
import { ThreadChat } from './lib/chat.js';
import { extractFromPage } from './lib/extract.js';
import { loadSettings, saveSettings, envDefaults } from './lib/settings.js';
import { toMarkdown, toCSV, toJSON } from './lib/export.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

const state = { settings: null, analysis: null, chat: null, abort: null, filter: 'all', chatBusy: false };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  users: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};
const VLABEL = { verified: 'Verified against source', review: 'Needs review', unsupported: 'Not supported by the thread' };

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2200);
}

function show(view) {
  for (const v of ['input', 'progress', 'results']) $(`#view-${v}`).hidden = v !== view;
  $('#btn-new').hidden = view !== 'results';
}

const cite = (id, quote = '') => `<button class="cite" data-id="${esc(id)}"${quote ? ` data-quote="${esc(quote)}"` : ''} title="Open email ${esc(id)}">${esc(id)}</button>`;
const cites = (ids = []) => ids.map((id) => cite(id)).join('');

function vdot(v) {
  if (!v?.status) return '';
  const icon = v.status === 'verified' ? ICON.check : v.status === 'review' ? ICON.warn : ICON.x;
  const why = v.judge?.reason ? ` — ${v.judge.reason}` : '';
  const failed = (v.checks || []).filter((c) => !c.ok).map((c) => c.name).join('; ');
  return `<span class="vdot ${v.status}" title="${esc(VLABEL[v.status] + why + (failed ? ` (failed: ${failed})` : ''))}">${icon}</span>`;
}

function avatar(name) {
  if (!name || /^(unassigned|none|unknown)$/i.test(name)) return '<span class="avatar none">?</span>';
  const initials = name.replace(/\[|\]/g, '').split(/[\s_]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="avatar" style="background:hsl(${h} 55% 50%)">${esc(initials)}</span>`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'thread';

// Tiny, safe Markdown renderer for chat answers (escape first, then format).
function md(text) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(M\d+(?:\s*[,;]\s*M\d+)*)\]/g, (_, ids) => ids.split(/\s*[,;]\s*/).map((id) => cite(id)).join(''));
  const lines = esc(text).split('\n');
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.t}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    const ul = l.match(/^[-*•]\s+(.*)/), ol = l.match(/^\d+[.)]\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const t = ul ? 'ul' : 'ol';
      if (!list || list.t !== t) { flushList(); list = { t, items: [] }; }
      list.items.push((ul || ol)[1]);
    } else if (!l) { flushPara(); flushList(); }
    else { flushList(); para.push(l.replace(/^#{1,4}\s+/, '')); }
  }
  flushPara(); flushList();
  return html;
}

// ---------- settings ----------
async function refreshSettings() {
  state.settings = await loadSettings();
  $('#opt-redact').checked = state.settings.redactContacts;
  $('#opt-names').checked = state.settings.pseudonymizeNames;
  $('#key-banner').hidden = !!state.settings.apiKey;
}

function openSettings() {
  const s = state.settings;
  $('#s-key').value = s.keySource === 'settings' ? s.apiKey : '';
  $('#s-key').placeholder = s.keySource === '.env' ? 'Using key from .env (leave blank)' : 'AIza…';
  $('#s-key-note').textContent = s.keySource === '.env'
    ? 'A key from .env is active. Paste one here to override it.'
    : 'Get one free at aistudio.google.com → API keys. Stored only in this browser.';
  $('#s-model').value = s.model;
  $('#s-verify').checked = s.verifyWithLLM;
  $('#s-single').value = s.singlePassTokenLimit;
  $('#s-chunk').value = s.chunkTokens;
  $('#settings').showModal();
}

async function saveSettingsFromForm(e) {
  e?.preventDefault();
  const s = {
    ...state.settings,
    apiKey: $('#s-key').value.trim(),
    model: $('#s-model').value.trim() || envDefaults().model,
    verifyWithLLM: $('#s-verify').checked,
    singlePassTokenLimit: Math.max(500, +$('#s-single').value || 1500),
    chunkTokens: Math.max(300, +$('#s-chunk').value || 900),
    redactContacts: $('#opt-redact').checked,
    pseudonymizeNames: $('#opt-names').checked,
  };
  await saveSettings(s);
  await refreshSettings();
  $('#settings').close();
  toast('Settings saved');
}

// ---------- input ----------
function updateInputState() {
  const v = $('#thread-input').value;
  $('#input-meta').textContent = `${v.length.toLocaleString()} characters`;
  $('#btn-clear').hidden = !v;
  $('#btn-analyse').disabled = v.trim().length < 20;
}

function setInput(text, hint = '', cls = '') {
  $('#thread-input').value = text;
  updateInputState();
  if (hint) { $('#grab-hint').textContent = hint; $('#grab-hint').className = `hint ${cls}`; }
}

async function loadSamples() {
  try {
    const list = await (await fetch('samples/index.json')).json();
    $('#sample-chips').innerHTML = list.map((s) => `<button class="chip" data-file="${esc(s.file)}" title="${esc(s.note)}">${esc(s.title)}</button>`).join('');
  } catch { $('.samples').hidden = true; }
}

async function grabFromTab() {
  if (!hasChrome) return toast('Grabbing only works inside the Chrome extension.', true);
  const btn = $('#btn-grab');
  btn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    let res;
    try {
      [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractFromPage });
    } catch (err) {
      // No access yet: ask for permission on this site, then retry once.
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
      if (!granted) throw new Error('ThreadLens needs permission to read this page. You can paste the thread instead.');
      [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractFromPage });
    }
    const out = res?.result;
    if (!out?.text) return setInput($('#thread-input').value, out?.hint || 'Couldn’t find a thread on this page. Select the text or paste it.', 'err');
    const label = out.source === 'Gmail' ? `Grabbed ${out.count} emails from Gmail ✓` : out.source === 'selection' ? 'Grabbed your selected text ✓' : `Grabbed page text (${out.source}) ✓ ${out.hint || ''}`;
    setInput(out.text, label, 'ok');
  } catch (e) {
    setInput($('#thread-input').value, e.message || String(e), 'err');
  } finally { btn.disabled = false; }
}

// ---------- progress ----------
const STEP_LABELS = {
  parse: 'Read & clean the thread', redact: 'Protect private data', plan: 'Plan for thread length',
  extract: 'Summarise & extract actions', reduce: 'Merge chunks', verify: 'Verify faithfulness',
};
function resetSteps() {
  $('#steps').innerHTML = ['parse', 'redact', 'plan', 'extract', 'verify']
    .map((k) => `<li data-step="${k}"><span class="dot"></span><div><span class="label">${STEP_LABELS[k]}</span><span class="detail"></span></div></li>`).join('');
}
function onProgress(step, detail, done) {
  if (step === 'done') return;
  let li = $(`#steps li[data-step="${step}"]`);
  if (!li && step === 'reduce') {
    $('#steps li[data-step="verify"]').insertAdjacentHTML('beforebegin', `<li data-step="reduce"><span class="dot"></span><div><span class="label">${STEP_LABELS.reduce}</span><span class="detail"></span></div></li>`);
    li = $('#steps li[data-step="reduce"]');
  }
  if (!li) return;
  // everything before this step is done
  let prev = li.previousElementSibling;
  while (prev) { prev.classList.remove('active'); prev.classList.add('done'); prev = prev.previousElementSibling; }
  li.classList.toggle('done', !!done);
  li.classList.toggle('active', !done);
  $('.detail', li).textContent = detail || '';
}

// ---------- analyse ----------
async function analyse() {
  const text = $('#thread-input').value;
  await refreshSettings();
  const s = { ...state.settings, redactContacts: $('#opt-redact').checked, pseudonymizeNames: $('#opt-names').checked };
  if (!s.apiKey) { openSettings(); return toast('Add your Gemini API key first.', true); }

  let llm;
  try { llm = new GeminiClient({ apiKey: s.apiKey, model: s.model }); } catch (e) { return toast(e.message, true); }
  state.abort = new AbortController();
  resetSteps();
  show('progress');
  try {
    const analysis = await analyzeThread(text, s, { llm, onProgress, signal: state.abort.signal });
    state.analysis = analysis;
    state.chat = new ThreadChat({ llm, analysis });
    state.filter = 'all';
    renderResults();
    show('results');
    switchTab('overview');
  } catch (e) {
    show('input');
    if (e.name !== 'AbortError') toast(e.message || 'Something went wrong.', true);
  } finally { state.abort = null; }
}

// ---------- results ----------
function renderResults() {
  const a = state.analysis;
  const r = a.result;
  const v = a.verification;
  $('#r-subject').textContent = a.subject;
  const secs = (a.stats.ms / 1000).toFixed(1);
  $('#r-meta').innerHTML = [
    `<span>${ICON.mail}${a.stats.messageCount} emails</span>`,
    `<span>${ICON.users}${a.participants.length} people</span>`,
    `<span title="${a.stats.mode === 'map-reduce' ? 'Long thread: processed in chunks, then merged' : 'Processed in one pass'}">${ICON.layers}${a.stats.mode === 'map-reduce' ? `${a.stats.chunks} chunks` : 'single pass'}</span>`,
    a.stats.privacy.total ? `<span title="Masked on-device before sending">${ICON.lock}${a.stats.privacy.total} masked</span>` : '',
    `<span>${ICON.clock}${secs}s</span>`,
  ].join('');

  const color = v.score >= 85 ? 'var(--ok)' : v.score >= 60 ? 'var(--warn)' : 'var(--bad)';
  const C = 2 * Math.PI * 22;
  $('#r-score').innerHTML = `<svg viewBox="0 0 54 54"><circle class="track" cx="27" cy="27" r="22"/><circle cx="27" cy="27" r="22" stroke="${color}" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - v.score / 100)}"/></svg><div class="val">${v.score}%</div><span class="lbl">faithful</span>`;

  $('#r-tldr').innerHTML = `<b>TL;DR</b>${esc(r.tldr)}`;
  const li = (text, item, sources) => `<li>${vdot(item.verification)}<span class="txt">${esc(text)} ${cites(sources)}</span></li>`;
  $('#r-summary').innerHTML = r.summary.map((s) => li(s.point, s, s.sources)).join('') || '<li class="empty">No summary</li>';
  $('#r-decisions').innerHTML = r.decisions.map((d) => li(d.decision, d, d.sources)).join('');
  $('#r-questions').innerHTML = r.open_questions.map((q) => li(q.question, q, q.sources)).join('');
  $('#r-decisions-wrap').hidden = !r.decisions.length;
  $('#r-questions-wrap').hidden = !r.open_questions.length;

  const p = a.stats.privacy;
  $('#r-how').innerHTML = `<ul>
    <li><b>Cleaned:</b> ${a.stats.messageCount} emails, ${Math.round(a.stats.quoteReduction * 100)}% of the text was quoted replies/signatures and was removed.</li>
    <li><b>Length strategy:</b> ~${a.stats.tokens.toLocaleString()} tokens → ${a.stats.mode === 'map-reduce' ? `split at email boundaries into ${a.stats.chunks} chunks, extracted in parallel, then merged (later emails override earlier ones)` : 'processed in a single pass'}.</li>
    <li><b>Privacy:</b> ${p.total ? `${p.total} values masked on this device before sending (${Object.entries(p.counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')}).` : 'nothing sensitive detected.'}</li>
    <li><b>Check 1 — quotes:</b> every action item must quote its source email verbatim; owners and deadlines must appear in the thread.</li>
    <li><b>Check 2 — AI fact-check:</b> ${v.judged ? 'a separate Gemini call re-read only the cited emails and judged each claim.' : 'off (enable in Settings).'}</li>
    <li><b>Result:</b> ${v.counts.verified} verified · ${v.counts.review} need review · ${v.counts.unsupported} unsupported, out of ${v.total} claims. ${a.stats.llmCalls} Gemini calls · ${esc(a.stats.model)}.</li>
  </ul>`;

  $('#c-actions').textContent = r.action_items.length;
  $('#c-sources').textContent = a.messages.length;
  renderActions();
  renderSources();
  resetChat();
}

function renderActions() {
  const items = state.analysis.result.action_items;
  $$('#action-filters .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === state.filter));
  const shown = items.filter((x) => state.filter === 'all' ? true
    : state.filter === 'review' ? x.verification?.status !== 'verified'
    : state.filter === 'open' ? x.status !== 'done' : x.status === 'done');
  // open & high priority first
  const rank = (x) => (x.status === 'done' ? 10 : 0) + { high: 0, medium: 1, low: 2 }[x.priority];
  shown.sort((a, b) => rank(a) - rank(b));
  $('#r-actions').innerHTML = shown.map((x) => {
    const vs = x.verification || {};
    const checks = (vs.checks || []).map((c) => `<li>${c.ok ? `<span class="y">${ICON.check}</span>` : `<span class="n">${ICON.x}</span>`}${esc(c.name)}${c.detail && !['exact'].includes(c.detail) ? ` <span>· ${esc(c.detail)}</span>` : ''}</li>`).join('');
    return `<article class="action ${x.status === 'done' ? 'is-done' : ''} ${vs.status || ''}">
      <div class="action-top">${vdot(vs)}<div class="task">${esc(x.task)}</div></div>
      <div class="action-meta">
        <span class="owner">${avatar(x.owner)}${esc(x.owner)}</span>
        ${!/^none$/i.test(x.due) ? `<span class="pill">${ICON.cal}${esc(x.due)}</span>` : ''}
        <span class="pill ${x.status}">${x.status}</span>
        ${x.status !== 'done' ? `<span class="pill ${x.priority}">${x.priority}</span>` : ''}
      </div>
      <details class="evidence">
        <summary>${ICON.chev}Evidence ${cite(x.source, x.evidence)}</summary>
        <div class="quote">“${esc(x.evidence)}”</div>
        <ul class="checks">${checks}</ul>
        ${vs.judge ? `<div class="judge"><b>AI fact-check:</b> ${esc(vs.judge.verdict)} — ${esc(vs.judge.reason)}</div>` : ''}
      </details>
    </article>`;
  }).join('') || `<div class="empty">No ${state.filter === 'all' ? '' : state.filter + ' '}action items.</div>`;
}

function renderSources() {
  $('#r-sources').innerHTML = state.analysis.messages.map((m) => `
    <div class="src" id="src-${m.id}">
      <div class="src-head"><span class="cite">${m.id}</span><b>${esc(m.from)}</b><span>${esc(m.date)}</span></div>
      <div class="src-body ${m.body.length > 420 ? 'clamped' : ''}">${esc(m.body)}</div>
      ${m.body.length > 420 ? `<button class="link more" data-more="${m.id}">Show full email</button>` : ''}
    </div>`).join('');
}

function openSource(id, quote) {
  const m = state.analysis?.messages.find((x) => x.id === id);
  if (!m) return;
  $('#d-id').textContent = id;
  $('#d-from').textContent = m.from + (m.fromEmail ? ` <${m.fromEmail}>` : '');
  $('#d-date').textContent = m.date;
  let body = esc(m.body);
  if (quote) {
    const q = esc(quote).trim();
    const idx = body.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0) body = body.slice(0, idx) + '<mark>' + body.slice(idx, idx + q.length) + '</mark>' + body.slice(idx + q.length);
  }
  $('#d-body').innerHTML = body;
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  $('mark', $('#d-body'))?.scrollIntoView({ block: 'center' });
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawer-backdrop').hidden = true; }

function switchTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  $('.export-bar').hidden = name === 'chat';
  if (name === 'chat') setTimeout(() => $('#chat-text').focus(), 50);
}

// ---------- chat ----------
function resetChat() {
  $$('#chat-log .msg').forEach((n) => n.remove());
  $('#chat-empty').hidden = false;
  const r = state.analysis.result;
  const owners = [...new Set(r.action_items.filter((x) => x.status !== 'done' && !/unassigned/i.test(x.owner)).map((x) => x.owner))];
  const sugg = [
    'What is still blocked or at risk?',
    owners[0] ? `What does ${owners[0]} need to do?` : 'Who owns what?',
    'Draft a follow-up email to the owners of open items',
    'What changed since the first email?',
  ];
  $('#chat-suggestions').innerHTML = sugg.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
}

function addMsg(role, html) {
  $('#chat-empty').hidden = true;
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.innerHTML = html;
  $('#chat-log').appendChild(d);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  return d;
}

async function ask(q) {
  q = q.trim();
  if (!q || state.chatBusy || !state.chat) return;
  state.chatBusy = true;
  $('#chat-form button').disabled = true;
  addMsg('user', esc(q));
  const bot = addMsg('bot', '<span class="typing"><span></span><span></span><span></span></span>');
  try {
    const { answer, scope } = await state.chat.ask(q, {
      onToken: (t) => { bot.innerHTML = md(t); $('#chat-log').scrollTop = $('#chat-log').scrollHeight; },
    });
    bot.innerHTML = md(answer) + `<span class="scope">Grounded in: ${esc(scope)}</span>`;
  } catch (e) {
    bot.classList.add('err');
    bot.textContent = e.message || 'Could not get an answer.';
  } finally {
    state.chatBusy = false;
    $('#chat-form button').disabled = false;
    $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  }
}

// ---------- wiring ----------
function wire() {
  $('#thread-input').addEventListener('input', updateInputState);
  $('#btn-clear').addEventListener('click', () => setInput('', 'Works best on an open Gmail thread. Elsewhere, select the text first.'));
  $('#btn-grab').addEventListener('click', grabFromTab);
  $('#btn-analyse').addEventListener('click', analyse);
  $('#btn-cancel').addEventListener('click', () => state.abort?.abort());
  $('#btn-new').addEventListener('click', () => show('input'));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#open-settings-link').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
  $('#settings-form').addEventListener('submit', saveSettingsFromForm);
  $('#s-cancel').addEventListener('click', () => $('#settings').close());
  $('#s-key-toggle').addEventListener('click', () => {
    const k = $('#s-key'); k.type = k.type === 'password' ? 'text' : 'password';
    $('#s-key-toggle').textContent = k.type === 'password' ? 'Show' : 'Hide';
  });
  $('#s-reset').addEventListener('click', async () => {
    await saveSettings({}); await refreshSettings(); $('#settings').close(); toast('Reset to .env defaults');
  });
  for (const id of ['#opt-redact', '#opt-names']) {
    $(id).addEventListener('change', () => saveSettings({ ...state.settings, redactContacts: $('#opt-redact').checked, pseudonymizeNames: $('#opt-names').checked }).then(refreshSettings));
  }

  $('#sample-chips').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-file]');
    if (!b) return;
    const text = await (await fetch(`samples/${b.dataset.file}`)).text();
    setInput(text, `Loaded sample: ${b.textContent}`, 'ok');
  });

  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#action-filters').addEventListener('click', (e) => {
    const c = e.target.closest('[data-filter]');
    if (c) { state.filter = c.dataset.filter; renderActions(); }
  });

  // citations anywhere → source drawer
  document.addEventListener('click', (e) => {
    const c = e.target.closest('button.cite');
    if (c) { e.preventDefault(); openSource(c.dataset.id, c.dataset.quote); return; }
    const more = e.target.closest('[data-more]');
    if (more) { const body = $(`#src-${more.dataset.more} .src-body`); body.style.maxHeight = 'none'; body.classList.remove('clamped'); more.remove(); }
  });
  $('#d-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // chat
  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#chat-text'); const q = t.value; t.value = ''; t.style.height = ''; ask(q); });
  $('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } });
  $('#chat-text').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });
  $('#chat-suggestions').addEventListener('click', (e) => { const c = e.target.closest('[data-q]'); if (c) ask(c.dataset.q); });

  // exports
  $('#exp-md').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toMarkdown(state.analysis)); toast('Copied as Markdown'); }
    catch { download(`${slug(state.analysis.subject)}.md`, toMarkdown(state.analysis), 'text/markdown'); }
  });
  $('#exp-csv').addEventListener('click', () => download(`${slug(state.analysis.subject)}-actions.csv`, toCSV(state.analysis), 'text/csv'));
  $('#exp-json').addEventListener('click', () => download(`${slug(state.analysis.subject)}.json`, toJSON(state.analysis), 'application/json'));

  // text sent from the right-click menu
  if (hasChrome && chrome.storage?.session) {
    const take = (p) => { if (p?.text) { setInput(p.text, 'Loaded your selected text ✓', 'ok'); show('input'); chrome.storage.session.remove('pendingText'); } };
    chrome.storage.session.get('pendingText').then((r) => take(r.pendingText));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && ch.pendingText?.newValue) take(ch.pendingText.newValue); });
  }
}

(async function init() {
  wire();
  await refreshSettings();
  await loadSamples();
  updateInputState();
})();
