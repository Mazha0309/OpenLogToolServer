import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale, ThemeMode } from './types';

interface PreferencesValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  dark: boolean;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function initialLocale(): Locale {
  const saved = localStorage.getItem('olt.web.locale');
  if (saved === 'zh-CN' || saved === 'en-US') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function initialTheme(): ThemeMode {
  const saved = localStorage.getItem('olt.web.theme');
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(initialTheme);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  const dark = themeMode === 'dark' || (themeMode === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const setLocale = (value: Locale) => { localStorage.setItem('olt.web.locale', value); setLocaleState(value); };
  const setThemeMode = (value: ThemeMode) => { localStorage.setItem('olt.web.theme', value); setThemeModeState(value); };
  const value = useMemo(
    () => ({ locale, setLocale, themeMode, setThemeMode, dark }),
    [locale, themeMode, dark],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

// oxlint-disable-next-line react/only-export-components
export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used inside PreferencesProvider');
  return context;
}
