import { createContext, useContext } from 'react';
import type { I18nValue } from '../hooks/useI18n';

export const I18nContext = createContext<I18nValue>(null!);

export function useI18nContext() {
  return useContext(I18nContext);
}
