import { strFromU8, unzipSync } from 'fflate';

export interface ParsedWorkbookRow {
  rowNumber: number;
  cells: string[];
}

export interface ParsedWorkbookSheet {
  name: string;
  rows: ParsedWorkbookRow[];
}

export interface ParsedWorkbook {
  fileName: string;
  utcOffsetMinutes: number;
  sheets: ParsedWorkbookSheet[];
}

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_SHEETS = 5;
const MAX_ROWS = 1_000;
const MAX_COLUMNS = 30;
const MAX_CELL_LENGTH = 500;
const MAX_TOTAL_CHARACTERS = 200_000;

function parseXml(bytes: Uint8Array | undefined, path: string): XMLDocument {
  if (!bytes) throw new Error(`EXCEL_PART_MISSING:${path}`);
  const xml = new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
  if (xml.getElementsByTagName('parsererror').length > 0) {
    throw new Error(`EXCEL_XML_INVALID:${path}`);
  }
  return xml;
}

function nodes(document: Document | Element, localName: string): Element[] {
  return Array.from(document.getElementsByTagNameNS('*', localName));
}

function normalizeZipPath(base: string, target: string): string {
  const parts = `${base}/${target}`.split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length === 0) throw new Error('EXCEL_RELATIONSHIP_INVALID');
      result.pop();
    } else {
      result.push(part);
    }
  }
  return result.join('/');
}

function relationshipTargets(archive: Record<string, Uint8Array>): Map<string, string> {
  const document = parseXml(archive['xl/_rels/workbook.xml.rels'], 'xl/_rels/workbook.xml.rels');
  const result = new Map<string, string>();
  for (const relationship of nodes(document, 'Relationship')) {
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    const mode = relationship.getAttribute('TargetMode');
    if (id && target && mode !== 'External') {
      result.set(id, normalizeZipPath('xl', target));
    }
  }
  return result;
}

function textRuns(element: Element): string {
  return nodes(element, 't').map((item) => item.textContent ?? '').join('');
}

function sharedStrings(archive: Record<string, Uint8Array>): string[] {
  const bytes = archive['xl/sharedStrings.xml'];
  if (!bytes) return [];
  const document = parseXml(bytes, 'xl/sharedStrings.xml');
  return nodes(document, 'si').map(textRuns);
}

interface Styles {
  numberFormatsByStyle: string[];
}

const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  14: 'm/d/yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
};

function parseStyles(archive: Record<string, Uint8Array>): Styles {
  const bytes = archive['xl/styles.xml'];
  if (!bytes) return { numberFormatsByStyle: [] };
  const document = parseXml(bytes, 'xl/styles.xml');
  const custom = new Map<number, string>();
  for (const numberFormat of nodes(document, 'numFmt')) {
    const id = Number(numberFormat.getAttribute('numFmtId'));
    const code = numberFormat.getAttribute('formatCode');
    if (Number.isSafeInteger(id) && code) custom.set(id, code);
  }
  const cellXfs = nodes(document, 'cellXfs')[0];
  const numberFormatsByStyle = cellXfs
    ? Array.from(cellXfs.children)
      .filter((element) => element.localName === 'xf')
      .map((element) => {
        const id = Number(element.getAttribute('numFmtId'));
        return custom.get(id) ?? BUILTIN_NUMBER_FORMATS[id] ?? '';
      })
    : [];
  return { numberFormatsByStyle };
}

function dateFormatKind(formatCode: string): 'date' | 'time' | 'dateTime' | null {
  const cleaned = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*]/g, '')
    .toLowerCase();
  const hasDate = /[yd]/.test(cleaned);
  const hasTime = /[hs]/.test(cleaned) || /(?:^|[^a-z])m{1,2}:(?:m{1,2}|s{1,2})/.test(cleaned);
  if (hasDate && hasTime) return 'dateTime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

function two(value: number): string {
  return value.toString().padStart(2, '0');
}

function excelDate(value: number, kind: NonNullable<ReturnType<typeof dateFormatKind>>, date1904: boolean, includeSeconds: boolean): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(base + value * 86_400_000);
  const day = `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`;
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}${includeSeconds ? `:${two(date.getUTCSeconds())}` : ''}`;
  if (kind === 'date') return day;
  if (kind === 'time') return time;
  return `${day} ${time}`;
}

function columnIndex(reference: string): number {
  const letters = /^[A-Za-z]+/.exec(reference)?.[0];
  if (!letters) throw new Error('EXCEL_CELL_REFERENCE_INVALID');
  let value = 0;
  for (const letter of letters.toUpperCase()) value = value * 26 + letter.charCodeAt(0) - 64;
  return value - 1;
}

function cellValue(
  cell: Element,
  strings: string[],
  styles: Styles,
  date1904: boolean,
): string {
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') return textRuns(cell);
  const raw = nodes(cell, 'v')[0]?.textContent ?? '';
  if (type === 's') {
    const index = Number(raw);
    return Number.isSafeInteger(index) ? strings[index] ?? '' : '';
  }
  if (type === 'str' || type === 'e') return raw;
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (raw === '') return '';
  const numeric = Number(raw);
  const styleIndex = Number(cell.getAttribute('s') ?? 0);
  const formatCode = Number.isSafeInteger(styleIndex) ? styles.numberFormatsByStyle[styleIndex] ?? '' : '';
  const kind = dateFormatKind(formatCode);
  if (Number.isFinite(numeric) && kind) {
    return excelDate(numeric, kind, date1904, /s/i.test(formatCode));
  }
  return raw;
}

function removeControlCharacters(value: string): string {
  return Array.from(value).filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 || codePoint === 9 || codePoint === 10 || codePoint === 13;
  }).join('');
}

function parseWorksheet(
  archive: Record<string, Uint8Array>,
  path: string,
  name: string,
  strings: string[],
  styles: Styles,
  date1904: boolean,
): ParsedWorkbookSheet {
  const document = parseXml(archive[path], path);
  const rows: ParsedWorkbookRow[] = [];
  for (const row of nodes(document, 'row')) {
    const rowNumber = Number(row.getAttribute('r'));
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) continue;
    const values: string[] = [];
    for (const cell of Array.from(row.children).filter((element) => element.localName === 'c')) {
      const reference = cell.getAttribute('r') ?? '';
      const index = columnIndex(reference);
      const value = removeControlCharacters(
        cellValue(cell, strings, styles, date1904),
      ).trim();
      if (!value) continue;
      if (index >= MAX_COLUMNS) throw new Error(`EXCEL_TOO_MANY_COLUMNS:${name}:${rowNumber}`);
      if (value.length > MAX_CELL_LENGTH) throw new Error(`EXCEL_CELL_TOO_LONG:${name}:${rowNumber}`);
      values[index] = value;
    }
    while (values.length > 0 && !values.at(-1)) values.pop();
    if (values.some(Boolean)) rows.push({
      rowNumber,
      cells: Array.from({ length: values.length }, (_, index) => values[index] ?? ''),
    });
  }
  return { name, rows };
}

export function parseXlsxWorkbook(
  bytes: Uint8Array,
  fileName: string,
  utcOffsetMinutes = -new Date().getTimezoneOffset(),
): ParsedWorkbook {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error('EXCEL_FILE_SIZE_INVALID');
  }
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error('EXCEL_ARCHIVE_INVALID');
  }
  const uncompressed = Object.values(archive).reduce((sum, value) => sum + value.byteLength, 0);
  if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('EXCEL_ARCHIVE_TOO_LARGE');
  const workbook = parseXml(archive['xl/workbook.xml'], 'xl/workbook.xml');
  const relationships = relationshipTargets(archive);
  const strings = sharedStrings(archive);
  const styles = parseStyles(archive);
  const date1904 = nodes(workbook, 'workbookPr')[0]?.getAttribute('date1904') === '1';
  const sheetNodes = nodes(workbook, 'sheet');
  if (sheetNodes.length === 0 || sheetNodes.length > MAX_SHEETS) {
    throw new Error('EXCEL_SHEET_COUNT_INVALID');
  }
  const sheets = sheetNodes.map((sheet, index) => {
    const name = sheet.getAttribute('name')?.trim() || `Sheet ${index + 1}`;
    const relationshipId = sheet.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'id',
    ) ?? sheet.getAttribute('r:id');
    const path = relationshipId ? relationships.get(relationshipId) : undefined;
    if (!path) throw new Error(`EXCEL_SHEET_RELATIONSHIP_MISSING:${name}`);
    return parseWorksheet(archive, path, name, strings, styles, date1904);
  }).filter((sheet) => sheet.rows.length > 0);
  const totalRows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  const totalCharacters = sheets.reduce((sheetSum, sheet) => sheetSum + sheet.rows.reduce(
    (rowSum, row) => rowSum + row.cells.reduce((cellSum, cell) => cellSum + cell.length, 0),
    0,
  ), 0);
  if (sheets.length === 0) throw new Error('EXCEL_HAS_NO_DATA');
  if (totalRows > MAX_ROWS) throw new Error('EXCEL_TOO_MANY_ROWS');
  if (totalCharacters > MAX_TOTAL_CHARACTERS) throw new Error('EXCEL_TOO_MUCH_TEXT');
  return { fileName, utcOffsetMinutes, sheets };
}

export async function parseXlsxFile(file: File): Promise<ParsedWorkbook> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error('EXCEL_XLSX_REQUIRED');
  return parseXlsxWorkbook(new Uint8Array(await file.arrayBuffer()), file.name);
}
