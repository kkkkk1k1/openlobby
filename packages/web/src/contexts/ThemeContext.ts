import { createContext, useContext } from 'react';
import type { Theme } from '../hooks/useTheme';

export interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextValue>(null!);

export function useThemeContext() {
  return useContext(ThemeContext);
}
