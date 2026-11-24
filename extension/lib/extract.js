// extract.js — pulls the open thread out of the current tab.
// `extractFromPage` is injected into the page with chrome.scripting, so it must be
// fully self-contained (no imports, no outer variables).

export async function extractFromPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const selection = String(window.getSelection ? window.getSelection() : '').trim();
  const host = location.hostname;

  const cleanText = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('.gmail_quote, .gmail_extra, blockquote, .yj6qo, .adL, style, script').forEach((n) => n.remove());
    return (c.innerText || c.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  };

  if (host === 'mail.google.com') {
    // Expand collapsed emails so the whole thread is included
    const expandAll = document.querySelector('[aria-label="Expand all"], [data-tooltip="Expand all"]');
    if (expandAll) { expandAll.click(); await sleep(1200); }
    const subject = (document.querySelector('h2.hP')?.innerText || document.title || '').trim();
    const nodes = [...document.querySelectorAll('div.adn')];
    const messages = nodes.map((n) => {
      const s = n.querySelector('span.gD');
      const body = n.querySelector('div.a3s');
      if (!body) return null;
      const dateEl = n.querySelector('span.g3');
      return {
        name: s?.getAttribute('name') || s?.innerText || 'Unknown',
        email: s?.getAttribute('email') || '',
        date: dateEl?.getAttribute('title') || dateEl?.innerText || '',
        body: cleanText(body),
      };
    }).filter(Boolean);
    if (messages.length) {
      const text = messages
        .map((m) => `From: ${m.name}${m.email ? ` <${m.email}>` : ''}\nDate: ${m.date}\nSubject: ${subject}\n\n${m.body}`)
        .join('\n\n==========\n\n');
      return { source: 'Gmail', subject, count: messages.length, text };
    }
    if (selection.length > 60) return { source: 'selection', text: selection };
    return { source: 'Gmail', count: 0, text: '', hint: 'Open an email thread in Gmail first (not the inbox list).' };
  }

  if (selection.length > 60) return { source: 'selection', text: selection };

  const main = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
  const text = (main.innerText || '').trim().slice(0, 300000);
  return { source: /outlook/.test(host) ? 'Outlook' : 'page', text,
    hint: /outlook/.test(host) ? 'Tip: for best results, select the thread text before grabbing.' : '' };
}
