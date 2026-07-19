import type { Locale } from './i18n';

const TIME_ONLY = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** Format a net record's business time to minute precision for display. */
export function formatLogTime(value: string | undefined, locale: Locale): string {
  if (!value) return '—';

  const timeOnly = TIME_ONLY.exec(value);
  if (timeOnly) {
    return `${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}`;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const parts = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((candidate) => candidate.type === type)?.value
  );
  const hour = part('hour');
  const minute = part('minute');
  return hour && minute ? `${hour}:${minute}` : value;
}
