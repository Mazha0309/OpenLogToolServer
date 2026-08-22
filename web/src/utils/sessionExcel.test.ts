import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { translate } from '../i18n';
import type { LogRecord, Page } from '../types';
import { buildSessionExcel, collectSessionLogs } from './sessionExcel';

const log = (overrides: Partial<LogRecord> = {}): LogRecord => ({
  syncId: 'log-1',
  sessionId: 'session-1',
  version: 1,
  time: '2026-08-22T12:03:04.000Z',
  controller: 'BG5CTRL',
  callsign: 'BG5CRL',
  rstSent: '59',
  rstRcvd: '57',
  qth: '浙江杭州',
  device: 'IC-705',
  power: '5W',
  antenna: '八木天线',
  height: '5楼',
  remarks: '=1+1',
  createdAt: '2026-08-22T12:03:04.000Z',
  updatedAt: '2026-08-22T12:03:04.000Z',
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deletedAt: null,
  ...overrides,
});

describe('session Excel export', () => {
  it('creates a real styled XLSX workbook with session and log content', () => {
    const bytes = buildSessionExcel({
      title: '周末 & 点名',
      locale: 'zh-CN',
      t: (key, values) => translate('zh-CN', key, values),
      logs: [log()],
    });
    const archive = unzipSync(bytes);
    expect(Object.keys(archive)).toContain('xl/worksheets/sheet1.xml');
    expect(Object.keys(archive)).toContain('xl/styles.xml');

    const sheet = strFromU8(archive['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('周末 &amp; 点名');
    expect(sheet).toContain('BG5CRL');
    expect(sheet).toContain('浙江杭州');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('=1+1');
    expect(sheet).toContain('mergeCell ref="A1:L1"');
    expect(sheet).toContain('state="frozen"');
  });

  it('loads every page in ascending order and omits deleted logs', async () => {
    const pages: Page<LogRecord>[] = [
      { items: [log()], page: 1, pageSize: 200, total: 2, totalPages: 2 },
      {
        items: [log({ syncId: 'deleted', deletedAt: '2026-08-22T13:00:00Z' })],
        page: 2,
        pageSize: 200,
        total: 2,
        totalPages: 2,
      },
    ];
    const loader = vi.fn(async ({ page }: { page: number }) => pages[page - 1]);

    await expect(collectSessionLogs(loader)).resolves.toEqual([pages[0].items[0]]);
    expect(loader).toHaveBeenNthCalledWith(1, {
      page: 1,
      pageSize: 200,
      includeDeleted: false,
      sort: 'timeAsc',
    });
    expect(loader).toHaveBeenNthCalledWith(2, {
      page: 2,
      pageSize: 200,
      includeDeleted: false,
      sort: 'timeAsc',
    });
  });
});
