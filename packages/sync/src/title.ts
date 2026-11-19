// The cleaning rule the notify relay applies, so a title cleaned here passes there unchanged.
// Matches every joiner that does not sit between two emoji, so it can be removed.
const STRAY_JOINER = /(?<!\p{Extended_Pictographic}[\u{FE0F}\p{Emoji_Modifier}]?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
const LINKISH = /:\/\/|www\./i;

/** Control characters become spaces, format characters go (except a joiner inside an emoji), whitespace collapses. */
export const clean = (raw: string): string =>
  raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(STRAY_JOINER, '')
    .replace(/[^\P{Cf}\u200D]/gu, '')
    .replace(/\p{Cs}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export const hasLink = (title: string): boolean => LINKISH.test(title);

/** The cleaned title, or null when the relay would refuse it. */
export function checkTitle(raw: string): string | null {
  const title = clean(raw);
  return !title || Array.from(title).length > 200 || hasLink(title) ? null : title;
}
