import { translate, type TranslationKey } from './i18n';
import { usePreferences } from './PreferencesContext';

export function useI18n() {
  const { locale } = usePreferences();
  return {
    locale,
    t: (key: TranslationKey, values?: Record<string, string | number>) => translate(locale, key, values),
  };
}
