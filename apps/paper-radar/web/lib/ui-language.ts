export type UiLanguage = 'zh' | 'en';
export const UI_LANGUAGE_KEY = 'paper-radar.ui-language.v1';

export function resolveUiLanguage(
  saved: unknown,
  browserLanguages: readonly string[] = [],
): UiLanguage {
  if (saved === 'zh' || saved === 'en') return saved;
  return browserLanguages[0]?.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

export function readUiLanguage(
  storage: Pick<Storage, 'getItem'> | null,
  browserLanguages: readonly string[] = [],
): UiLanguage {
  try {
    return resolveUiLanguage(
      storage?.getItem(UI_LANGUAGE_KEY),
      browserLanguages,
    );
  } catch {
    return resolveUiLanguage(null, browserLanguages);
  }
}

export function saveUiLanguage(
  storage: Pick<Storage, 'setItem'> | null,
  language: UiLanguage,
): void {
  try {
    storage?.setItem(UI_LANGUAGE_KEY, language);
  } catch {
    // The current session still switches when browser storage is unavailable.
  }
}
