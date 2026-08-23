import { AppError } from '../errors/app-error';
import { rejectUnknownKeys, requireJsonObject, requireString } from '../utils/validation';

export const EXCEL_EXPORT_SETTINGS_FORMAT_VERSION = 1 as const;

export interface ExcelExportSettings {
  formatVersion: typeof EXCEL_EXPORT_SETTINGS_FORMAT_VERSION;
  headerText: string;
  useSessionTitleAsHeader: boolean;
  useSessionTitleAsFileName: boolean;
  headerBackgroundColor: string;
  headerRowBackgroundColor: string;
  controllerBackgroundColor: string;
  tableBackgroundColor: string;
  alternateRowColor: string;
  useAlternateColors: boolean;
  fontFamily: string;
  showFooter: boolean;
  fileNameTemplate: string;
}

const SETTINGS_KEYS = [
  'formatVersion',
  'headerText',
  'useSessionTitleAsHeader',
  'useSessionTitleAsFileName',
  'headerBackgroundColor',
  'headerRowBackgroundColor',
  'controllerBackgroundColor',
  'tableBackgroundColor',
  'alternateRowColor',
  'useAlternateColors',
  'fontFamily',
  'showFooter',
  'fileNameTemplate',
] as const;

export const DEFAULT_EXCEL_EXPORT_SETTINGS: Readonly<ExcelExportSettings> = Object.freeze({
  formatVersion: EXCEL_EXPORT_SETTINGS_FORMAT_VERSION,
  headerText: '{yyyy}-{MM}-{dd}日点名记录',
  useSessionTitleAsHeader: true,
  useSessionTitleAsFileName: true,
  headerBackgroundColor: '#1E84D2FF',
  headerRowBackgroundColor: '#CFE7FFFF',
  controllerBackgroundColor: '#FFFFC3FF',
  tableBackgroundColor: '#FFFFFFFF',
  alternateRowColor: '#C0E5F2FF',
  useAlternateColors: true,
  fontFamily: 'SarasaGothicSC',
  showFooter: true,
  fileNameTemplate: '点名记录_{yyyy}-{MM}-{dd}',
});

function requireBoolean(value: Record<string, unknown>, field: string): boolean {
  if (typeof value[field] !== 'boolean') {
    throw new AppError(422, 'VALIDATION_FAILED', `${field} must be a boolean`, { field });
  }
  return value[field];
}

function requireColor(value: Record<string, unknown>, field: string): string {
  const color = requireString(value, field, { min: 7, max: 9 }).toUpperCase();
  if (!/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(color)) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      `${field} must use #RRGGBB or #RRGGBBAA notation`,
      { field },
    );
  }
  return color.length === 7 ? `${color}FF` : color;
}

export function validateExcelExportSettings(value: unknown): ExcelExportSettings {
  const settings = requireJsonObject(value);
  rejectUnknownKeys(settings, SETTINGS_KEYS);
  if (settings.formatVersion !== EXCEL_EXPORT_SETTINGS_FORMAT_VERSION) {
    throw new AppError(
      422,
      'EXCEL_EXPORT_SETTINGS_VERSION_UNSUPPORTED',
      'The Excel export settings format version is not supported',
      {
        expected: EXCEL_EXPORT_SETTINGS_FORMAT_VERSION,
        received: settings.formatVersion,
      },
    );
  }
  return {
    formatVersion: EXCEL_EXPORT_SETTINGS_FORMAT_VERSION,
    headerText: requireString(settings, 'headerText', { min: 0, max: 200, trim: false }),
    useSessionTitleAsHeader: requireBoolean(settings, 'useSessionTitleAsHeader'),
    useSessionTitleAsFileName: requireBoolean(settings, 'useSessionTitleAsFileName'),
    headerBackgroundColor: requireColor(settings, 'headerBackgroundColor'),
    headerRowBackgroundColor: requireColor(settings, 'headerRowBackgroundColor'),
    controllerBackgroundColor: requireColor(settings, 'controllerBackgroundColor'),
    tableBackgroundColor: requireColor(settings, 'tableBackgroundColor'),
    alternateRowColor: requireColor(settings, 'alternateRowColor'),
    useAlternateColors: requireBoolean(settings, 'useAlternateColors'),
    fontFamily: requireString(settings, 'fontFamily', { min: 0, max: 100, trim: false }),
    showFooter: requireBoolean(settings, 'showFooter'),
    fileNameTemplate: requireString(settings, 'fileNameTemplate', {
      min: 0,
      max: 200,
      trim: false,
    }),
  };
}

export function defaultExcelExportSettings(): ExcelExportSettings {
  return { ...DEFAULT_EXCEL_EXPORT_SETTINGS };
}
