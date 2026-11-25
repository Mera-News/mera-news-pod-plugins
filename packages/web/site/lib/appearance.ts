export type Appearance = 'system' | 'light' | 'dark';

const KEY = 'mera-news-appearance';

/** Runs in the page head before first paint, so a chosen theme never flashes; the page's CSP allows it by hash. */
export const APPEARANCE_SCRIPT = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

/** What the page shows now: the head script has already applied any saved choice. */
export function currentAppearance(): Appearance {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

/** Applies a choice and saves it in this browser; where storage is blocked it still applies until the page closes. */
export function setAppearance(a: Appearance) {
  if (a === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = a;
  try {
    if (a === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, a);
  } catch {
    // Storage can be blocked; the choice holds for this page.
  }
}
