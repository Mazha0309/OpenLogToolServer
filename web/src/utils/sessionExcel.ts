import { strToU8, zipSync } from 'fflate';
import type { TranslationKey } from '../i18n';
import type { LogRecord, Page } from '../types';

const PAGE_SIZE = 200;
const COLUMN_WIDTHS = [7, 14, 16, 16, 10, 10, 22, 20, 12, 20, 12, 34] as const;

type Translator = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => string;

export interface SessionExcelRequest {
  page: number;
  pageSize: number;
  includeDeleted?: boolean;
  sort?: 'timeAsc' | 'timeDesc' | 'updatedDesc';
}

export interface SessionExcelOptions {
  title: string;
  locale: string;
  t: Translator;
  loadLogs: (request: SessionExcelRequest) => Promise<Page<LogRecord>>;
}

export async function collectSessionLogs(
  loadLogs: SessionExcelOptions['loadLogs'],
): Promise<LogRecord[]> {
  const logs: LogRecord[] = [];
  let page = 1;
  while (true) {
    const result = await loadLogs({
      page,
      pageSize: PAGE_SIZE,
      includeDeleted: false,
      sort: 'timeAsc',
    });
    logs.push(...result.items.filter((item) => !item.deletedAt));
    if (page >= result.totalPages || result.items.length === 0) break;
    page += 1;
    if (page > 10_000) throw new Error('SESSION_EXCEL_PAGE_LIMIT');
  }
  return logs.sort((left, right) =>
    left.time.localeCompare(right.time) || left.syncId.localeCompare(right.syncId),
  );
}

export async function exportSessionExcel(
  options: SessionExcelOptions,
): Promise<number> {
  const logs = await collectSessionLogs(options.loadLogs);
  const bytes = buildSessionExcel({ ...options, logs });
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  const blob = new Blob([payload], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = `${safeFileName(options.title)}.xlsx`;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return logs.length;
}

export function buildSessionExcel({
  title,
  locale,
  t,
  logs,
}: Omit<SessionExcelOptions, 'loadLogs'> & { logs: LogRecord[] }): Uint8Array {
  const headers = [
    '#',
    t('common.time'),
    t('logs.controller'),
    t('logs.callsign'),
    t('logs.rstSent'),
    t('logs.rstRcvd'),
    t('logs.qth'),
    t('logs.device'),
    t('logs.power'),
    t('logs.antenna'),
    t('logs.height'),
    t('logs.remarks'),
  ];
  const rows = logs.map((log, index) => [
    String(index + 1),
    displayTime(log.time, locale),
    log.controller,
    log.callsign,
    log.rstSent ?? '',
    log.rstRcvd ?? '',
    log.qth ?? '',
    log.device ?? '',
    log.power ?? '',
    log.antenna ?? '',
    log.height ?? '',
    log.remarks ?? '',
  ]);
  const lastRow = Math.max(2, rows.length + 2);
  const columnXml = COLUMN_WIDTHS.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
  ).join('');
  const headerXml = headers.map((value, index) => cell(index, 2, value, 2)).join('');
  const rowXml = rows.map((values, rowIndex) => {
    const excelRow = rowIndex + 3;
    const style = rowIndex % 2 === 0 ? 3 : 4;
    return `<row r="${excelRow}" ht="22" customHeight="1">${values
      .map((value, columnIndex) => cell(columnIndex, excelRow, value, style))
      .join('')}</row>`;
  }).join('');
  const worksheet = xml(`
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <dimension ref="A1:L${lastRow}"/>
      <sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
      <sheetFormatPr defaultRowHeight="22"/>
      <cols>${columnXml}</cols>
      <sheetData>
        <row r="1" ht="30" customHeight="1">${cell(0, 1, title.trim() || t('sessions.session'), 1)}</row>
        <row r="2" ht="24" customHeight="1">${headerXml}</row>
        ${rowXml}
      </sheetData>
      <autoFilter ref="A2:L${lastRow}"/>
      <mergeCells count="1"><mergeCell ref="A1:L1"/></mergeCells>
      <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
      <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
    </worksheet>
  `);

  return zipSync({
    '[Content_Types].xml': strToU8(xml(`
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
      </Types>
    `)),
    '_rels/.rels': strToU8(xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>
    `)),
    'xl/workbook.xml': strToU8(xml(`
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="${escapeXml(t('sessions.logs')).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>
      </workbook>
    `)),
    'xl/_rels/workbook.xml.rels': strToU8(xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      </Relationships>
    `)),
    'xl/styles.xml': strToU8(stylesXml()),
    'xl/worksheets/sheet1.xml': strToU8(worksheet),
  }, { level: 6 });
}

function cell(column: number, row: number, value: string, style: number): string {
  const reference = `${columnName(column)}${row}`;
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function displayTime(value: string, locale: string): string {
  const direct = value.trim().match(/^\d{1,2}:\d{2}(?::\d{2})?/);
  if (direct) return direct[0];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function safeFileName(value: string): string {
  const withoutControls = Array.from(value, (character) =>
    character.codePointAt(0)! < 32 ? '_' : character,
  ).join('');
  const sanitized = withoutControls
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100);
  return sanitized || 'session';
}

function escapeXml(value: string): string {
  const validXml = Array.from(value).filter((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint >= 32 || codePoint === 9 || codePoint === 10 || codePoint === 13;
  }).join('');
  return validXml
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body.replace(/>\s+</g, '><').trim()}`;
}

function stylesXml(): string {
  return xml(`
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <fonts count="3">
        <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
        <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
        <font><b/><sz val="11"/><color rgb="FF17212B"/><name val="Calibri"/></font>
      </fonts>
      <fills count="4">
        <fill><patternFill patternType="none"/></fill>
        <fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FF1565C0"/><bgColor indexed="64"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFDCEBFA"/><bgColor indexed="64"/></patternFill></fill>
      </fills>
      <borders count="2">
        <border><left/><right/><top/><bottom/><diagonal/></border>
        <border><left style="thin"><color rgb="FFB9C3CE"/></left><right style="thin"><color rgb="FFB9C3CE"/></right><top style="thin"><color rgb="FFB9C3CE"/></top><bottom style="thin"><color rgb="FFB9C3CE"/></bottom><diagonal/></border>
      </borders>
      <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
      <cellXfs count="5">
        <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
        <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
        <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
        <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
        <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
      </cellXfs>
      <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
    </styleSheet>
  `);
}
