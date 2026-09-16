'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Languages } from 'lucide-react';
import {
  UI_LANGUAGE_KEY,
  readUiLanguage,
  resolveUiLanguage,
  saveUiLanguage,
  type UiLanguage,
} from '@/lib/ui-language';
import { translateUi } from '@/lib/ui-messages';

export const UiLanguageContext = createContext<{
  language: UiLanguage;
  setLanguage: (language: UiLanguage) => void;
}>({ language: 'zh', setLanguage: () => {} });

export function UiLanguageProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Match the static HTML for hydration; browser preferences apply after mount.
  const [language, setLanguage] = useState<UiLanguage>('zh');
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* Storage may be disabled. */
    }
    let active = true;
    void Promise.resolve().then(() => {
      if (active) setLanguage(readUiLanguage(storage, navigator.languages));
    });
    const sync = (event: StorageEvent) => {
      if (event.key === UI_LANGUAGE_KEY || event.key === null)
        setLanguage(resolveUiLanguage(event.newValue, navigator.languages));
    };
    window.addEventListener('storage', sync);
    return () => {
      active = false;
      window.removeEventListener('storage', sync);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title =
      language === 'zh'
        ? 'Paper Radar · 研究工作台'
        : 'Paper Radar · Research workspace';
  }, [language]);
  const value = useMemo(
    () => ({
      language,
      setLanguage: (next: UiLanguage) => {
        setLanguage(next);
        try {
          saveUiLanguage(window.localStorage, next);
        } catch {
          /* Keep the session preference. */
        }
      },
    }),
    [language],
  );
  return (
    <UiLanguageContext.Provider value={value}>
      {children}
    </UiLanguageContext.Provider>
  );
}

export function useUiLanguage() {
  const { language: uiLanguage, setLanguage } = useContext(UiLanguageContext);
  return useMemo(
    () => ({
      uiLanguage,
      setLanguage,
      locale: uiLanguage === 'zh' ? 'zh-CN' : 'en-US',
      ui: <T,>(
        value: T,
        parameters?: readonly (string | number | null | undefined)[],
      ): T => translateUi(value, uiLanguage, parameters),
    }),
    [uiLanguage, setLanguage],
  );
}

export function LanguageSwitcher({
  segmented = false,
}: {
  segmented?: boolean;
}) {
  const { uiLanguage, setLanguage } = useUiLanguage();
  if (segmented)
    return (
      <div className="ui-language-segmented">
        <span>
          <Languages size={15} aria-hidden="true" />
          {uiLanguage === 'zh' ? '界面语言' : 'UI language'}
        </span>
        <fieldset
          className="ui-language-options"
          aria-label={uiLanguage === 'zh' ? '界面语言' : 'UI language'}
        >
          {(['zh', 'en'] as const).map((language) => (
            <button
              type="button"
              key={language}
              lang={language === 'zh' ? 'zh-CN' : 'en'}
              aria-pressed={uiLanguage === language}
              onClick={() => setLanguage(language)}
            >
              {language === 'zh' ? '中文' : 'EN'}
            </button>
          ))}
        </fieldset>
      </div>
    );
  return (
    <label className="ui-language-switcher">
      <Languages size={16} aria-hidden="true" />
      <span className="sr-only">
        {uiLanguage === 'zh' ? '界面语言' : 'Interface language'}
      </span>
      <select
        aria-label={uiLanguage === 'zh' ? '界面语言' : 'Interface language'}
        value={uiLanguage}
        onChange={(event) =>
          setLanguage(event.target.value === 'en' ? 'en' : 'zh')
        }
      >
        <option value="zh" lang="zh-CN">
          中文
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </label>
  );
}
