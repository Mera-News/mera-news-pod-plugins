// The news card: an MCP Apps view an AI app draws inline under its reply. It shows the stories a
// news tool returned, each with its headline, publisher, time and the publisher's link, so the
// source is on screen whatever the model writes. Apps without MCP Apps get the text reply only.

export const CARD_URI = 'ui://mera-news/stories.html';
export const CARD_MIME = 'text/html;profile=mcp-app';
/** The tools whose reply the card draws. */
export const CARD_TOOLS = new Set(['get_suggestions', 'top_stories', 'news_for_profile', 'search_news', 'latest_news']);

export interface CardStory {
  title: string;
  titleEn?: string;
  link: string;
  publisher: string;
  publishedAt?: string;
  level?: string;
  reason?: string;
  /** Other publishers' reports of the same story. */
  others: { publisher: string; link: string }[];
  /** How many others reported it, as its show line says: "+8 publications", or "+2 reports" when the publishers are not known. */
  more?: string;
}
export interface CardSection {
  heading: string;
  stories: CardStory[];
}

/**
 * The sections a tool reply shows. Runs in the view (it is copied into the page with toString), so
 * it must reference nothing outside itself. Only http(s) links pass.
 */
export function sectionsOf(reply: unknown): CardSection[] {
  const web = (u: unknown) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
  const str = (s: unknown) => (typeof s === 'string' ? s : '');
  const LEVELS = ['emergency', 'high', 'medium', 'low'];
  // The same rule as the show line: other publications when known, else other reports.
  const plus = (out: CardStory, publications: number, reports: number) => {
    const [n, word] = publications > 0 ? [publications, 'publication'] : [reports, 'report'];
    if (n > 0) out.more = `+${n} ${word}${n === 1 ? '' : 's'}`;
  };
  const story = (s: any, others: { publisher: string; link: string }[] = []): CardStory[] => {
    const link = web(s?.link ?? s?.url);
    if (!link) return [];
    const out: CardStory = { title: str(s.title), link, publisher: str(s.publisher ?? s.publication), others };
    if (str(s.title_en)) out.titleEn = str(s.title_en);
    if (str(s.publishedAt)) out.publishedAt = str(s.publishedAt);
    if (str(s.level)) out.level = str(s.level);
    if (str(s.reason)) out.reason = str(s.reason);
    const publishers = typeof s.publisherCount === 'number' ? s.publisherCount : 0;
    const reports = typeof s.reportCount === 'number' ? s.reportCount : typeof s.reports === 'number' ? s.reports : 0;
    plus(out, publishers > 1 ? publishers - 1 : 0, publishers > 0 ? 0 : reports - 1);
    return [out];
  };
  const reportsOf = (s: any) =>
    (Array.isArray(s?.reports) ? s.reports : [])
      .map((r: any) => ({ publisher: str(r?.publisher), link: web(r?.link) }))
      .filter((r: { link: string }) => r.link && r.link !== web(s.link));
  const byLevel = (list: CardStory[]) => [...list].sort((a, b) => LEVELS.indexOf(a.level ?? 'low') - LEVELS.indexOf(b.level ?? 'low'));
  const r: any = reply && typeof reply === 'object' ? reply : {};
  const sections: CardSection[] = [];
  const add = (heading: string, stories: CardStory[]) => {
    if (stories.length) sections.push({ heading, stories });
  };

  if (Array.isArray(r.picks)) add('Picked for you', byLevel(r.picks.flatMap((p: any) => story(p))));
  if (Array.isArray(r.picked) || Array.isArray(r.leftOut) || Array.isArray(r.toJudge)) {
    add('Picked for you', byLevel((r.picked ?? []).flatMap((p: any) => story(p))));
    add('Left out', (r.leftOut ?? []).flatMap((p: any) => story(p)));
    for (const group of r.toJudge ?? []) add(str(group?.fact) ? `Matches for: ${str(group.fact)}` : 'Matches', (group?.stories ?? []).flatMap((s: any) => story(s)));
  }
  if (Array.isArray(r.stories)) {
    const scope = str(r.scope);
    add(scope && scope !== 'world' ? `Top stories in ${scope}` : 'Top stories', r.stories.flatMap((s: any) => story(s, reportsOf(s))));
  } else if (str(r.story) && Array.isArray(r.reports)) {
    add('Reports of this story', r.reports.flatMap((s: any) => story(s)));
  }
  if (Array.isArray(r.results)) {
    // Results that share a story become one story with every publisher's link.
    const out: CardStory[] = [];
    const seen = new Map<string, CardStory>();
    for (const s of r.results) {
      const key = str(s?.story);
      const lead = key ? seen.get(key) : undefined;
      if (lead && web(s?.link)) {
        lead.others.push({ publisher: str(s.publisher), link: web(s.link) });
        plus(lead, 0, lead.others.length);
        continue;
      }
      const [made] = story(s);
      if (!made) continue;
      out.push(made);
      if (key) seen.set(key, made);
    }
    add('News', out);
  }
  return sections;
}

const STYLE = `
:root{color-scheme:light dark;--bg:var(--color-background-primary,light-dark(#fff,#1c1c1e));--card:var(--color-background-secondary,light-dark(#f5f5f7,#2c2c2e));--text:var(--color-text-primary,light-dark(#1d1d1f,#f5f5f7));--muted:var(--color-text-secondary,light-dark(#6e6e73,#a1a1a6));--line:var(--color-border-primary,light-dark(#e5e5ea,#3a3a3c));--accent:light-dark(#d9480f,#ff8a4c)}
:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
body{display:flex;flex-direction:column;max-height:560px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:2px 2px 8px;font-size:13px;font-weight:600;color:var(--muted)}
header .head{text-transform:uppercase;letter-spacing:.02em}
main{display:flex;flex-direction:column;gap:14px;padding:2px;flex:1;min-height:0;overflow-y:auto}
footer{padding:8px 2px 2px}
h2{font-size:13px;font-weight:600;color:var(--muted);margin:0 0 6px;text-transform:uppercase;letter-spacing:.02em}
.foot{margin:0}
ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
li{background:var(--card);border-radius:12px;padding:12px 14px}
.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px;color:var(--muted);margin-bottom:4px}
.pub{font-weight:600;color:var(--text)}
.level{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--line)}
.level.emergency,.level.high{color:var(--accent);border-color:var(--accent)}
a.title{display:block;color:var(--text);font-weight:600;text-decoration:none;font-size:16px}
a.title:hover{text-decoration:underline}
.en{color:var(--muted);font-size:13px;margin-top:2px}
.reason{margin-top:6px}
.others{margin-top:6px;font-size:13px;color:var(--muted)}
.more{font-weight:600;color:var(--text)}
.others a{color:inherit}
.read{display:inline-block;margin-top:8px;font-size:13px;font-weight:600;color:var(--accent);text-decoration:none}
.foot{font-size:12px;color:var(--muted)}
`;

// The page script: the MCP Apps handshake, then draw each tool result. Nodes are built with
// textContent; links open through the host, since a sandboxed frame cannot navigate itself.
// __name: esbuild's keepNames wraps functions inside the copied source in a helper the page lacks.
const SCRIPT = `
var __name = (f) => f;
const sectionsOf = ${sectionsOf.toString()};
let nextId = 1;
const waiting = new Map();
const send = (msg) => window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); send({ id, method, params }); });
const notify = (method, params) => send({ method, params });
const applyContext = (c) => {
  if (!c) return;
  if (c.theme === 'light' || c.theme === 'dark') document.documentElement.dataset.theme = c.theme;
  const vars = c.styles && c.styles.variables;
  if (vars) for (const [k, v] of Object.entries(vars)) if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
};
const open = (url) => request('ui/open-link', { url }).catch(() => window.open(url, '_blank', 'noopener'));
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
const link = (cls, url, text) => { const a = el('a', cls, text); a.href = url; a.rel = 'noopener noreferrer'; a.target = '_blank'; a.addEventListener('click', (e) => { e.preventDefault(); open(url); }); return a; };
const LEVEL = { emergency: 'Emergency', high: 'High', medium: 'Medium', low: 'Low' };
const ago = (iso) => {
  const t = Date.parse(iso); if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  const f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(m) < 60) return f.format(-m, 'minute');
  if (Math.abs(m) < 2880) return f.format(-Math.round(m / 60), 'hour');
  return f.format(-Math.round(m / 1440), 'day');
};
const draw = (result) => {
  const main = document.querySelector('main');
  main.replaceChildren();
  document.querySelector('footer').replaceChildren();
  const head = document.querySelector('header');
  head.replaceChildren();
  let reply = result && result.structuredContent;
  if (!reply) { try { reply = JSON.parse(((result && result.content) || []).find((c) => c.type === 'text').text); } catch { reply = null; } }
  const sections = sectionsOf(reply);
  const total = sections.reduce((n, s) => n + s.stories.length, 0);
  if (total) head.append(el('span', 'head', sections.length === 1 ? sections[0].heading : 'Mera News'), el('span', 'count', total === 1 ? '1 story' : total + ' stories'));
  for (const s of sections) {
    const sec = el('section'); if (sections.length > 1) sec.append(el('h2', '', s.heading));
    const ol = el('ol');
    for (const st of s.stories) {
      const li = el('li');
      const meta = el('div', 'meta');
      meta.append(el('span', 'pub', st.publisher || new URL(st.link).hostname));
      if (st.more) meta.append(el('span', 'more', st.more));
      const when = st.publishedAt ? ago(st.publishedAt) : '';
      if (when) meta.append(el('span', '', when));
      if (st.level && LEVEL[st.level]) meta.append(el('span', 'level ' + st.level, LEVEL[st.level]));
      li.append(meta, link('title', st.link, st.title || st.titleEn || st.link));
      if (st.titleEn && st.titleEn !== st.title) li.append(el('div', 'en', st.titleEn));
      if (st.reason) li.append(el('div', 'reason', st.reason));
      if (st.others.length) {
        const o = el('div', 'others', 'Also reported by ');
        st.others.forEach((r, i) => { if (i) o.append(', '); o.append(link('', r.link, r.publisher || new URL(r.link).hostname)); });
        li.append(o);
      }
      li.append(link('read', st.link, 'Read at ' + (st.publisher || new URL(st.link).hostname)));
      ol.append(li);
    }
    sec.append(ol); main.append(sec);
  }
  if (total) document.querySelector('footer').append(el('p', 'foot', 'Each story belongs to its publisher. Read it on their site.'));
};
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id !== undefined && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(m.error) : w.resolve(m.result); return; }
  if (m.method === 'ui/notifications/tool-result') draw(m.params);
  else if (m.method === 'ui/notifications/host-context-changed') applyContext(m.params);
  else if (m.method === 'ui/resource-teardown' && m.id !== undefined) send({ id: m.id, result: {} });
});
new ResizeObserver(() => notify('ui/notifications/size-changed', { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })).observe(document.documentElement);
const info = { name: 'mera-news-card', version: '1.0.0' };
request('ui/initialize', { appInfo: info, appCapabilities: { availableDisplayModes: ['inline'] }, protocolVersion: '2026-01-26' })
  .then((r) => { applyContext(r && r.hostContext); notify('ui/notifications/initialized', {}); })
  .catch(() => notify('ui/notifications/initialized', {}));
`;

export const cardHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mera News</title><style>${STYLE}</style></head><body><header></header><main></main><footer></footer><script>${SCRIPT}</script></body></html>`;
