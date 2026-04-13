import { useCallback, useEffect, useMemo, useState } from 'react';
import { enMessages } from '../i18n/en';
import { zhCNMessages } from '../i18n/zh-CN';
import type { Locale, MessageKey, Messages, TranslationParams } from '../i18n/types';

const STORAGE_KEY = 'openlobby-locale';

const dictionaries: Record<Locale, Messages> = {
  'zh-CN': zhCNMessages,
  en: enMessages,
};

function normalizeLocale(value: string | null | undefined): Locale | null {
  if (value == null) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';
  return null;
}

function getBrowserLocale(): Locale {
  return normalizeLocale(window.navigator.language) ?? 'en';
}

function getStoredLocale(): Locale {
  return normalizeLocale(window.localStorage.getItem(STORAGE_KEY)) ?? getBrowserLocale();
}

function interpolate(template: string, params?: TranslationParams): string {
  if (params == null) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    return value == null ? '' : String(value);
  });
}

export function useI18n() {
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, locale);
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const messages = dictionaries[locale];

  const t = useCallback(
    (key: MessageKey, params?: TranslationParams) => interpolate(messages[key], params),
    [messages],
  );

  return useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );
}

export type I18nValue = ReturnType<typeof useI18n>;
