import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../PreferencesContext';
import type { ExcelExportSettings } from '../types';
import { ExcelExportActions } from './ExcelExportActions';

const { accountApi } = vi.hoisted(() => ({
  accountApi: {
    excelExportSettings: vi.fn(),
    updateExcelExportSettings: vi.fn(),
  },
}));

vi.mock('../api', () => ({ accountApi }));

const settings: ExcelExportSettings = {
  formatVersion: 1,
  headerText: 'Account heading',
  useSessionTitleAsHeader: false,
  useSessionTitleAsFileName: false,
  headerBackgroundColor: '#112233FF',
  headerRowBackgroundColor: '#223344FF',
  controllerBackgroundColor: '#334455FF',
  tableBackgroundColor: '#445566FF',
  alternateRowColor: '#556677FF',
  useAlternateColors: true,
  fontFamily: 'Arial',
  showFooter: true,
  fileNameTemplate: 'account-template',
};

describe('ExcelExportActions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    accountApi.excelExportSettings.mockResolvedValue({
      excelExportSettings: settings,
      persisted: true,
      updatedAt: '2026-08-23T00:00:00.000Z',
    });
    accountApi.updateExcelExportSettings.mockImplementation(
      (excelExportSettings: ExcelExportSettings) => Promise.resolve({
        excelExportSettings,
        persisted: true,
        updatedAt: '2026-08-23T00:01:00.000Z',
      }),
    );
  });

  afterEach(cleanup);

  it('loads and saves the current account settings', async () => {
    render(
      <PreferencesProvider>
        <App>
          <ExcelExportActions
            title="Friday net"
            loadLogs={vi.fn()}
          />
        </App>
      </PreferencesProvider>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Excel export settings' }));
    const fileNameInput = await screen.findByDisplayValue('account-template');
    await user.clear(fileNameInput);
    await user.type(fileNameInput, 'updated-template');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(accountApi.updateExcelExportSettings).toHaveBeenCalledWith({
      ...settings,
      fileNameTemplate: 'updated-template',
    }));
    expect(accountApi.excelExportSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the edited settings visible when saving fails', async () => {
    accountApi.updateExcelExportSettings.mockRejectedValue(new Error('offline'));
    render(
      <PreferencesProvider>
        <App>
          <ExcelExportActions title="Friday net" loadLogs={vi.fn()} />
        </App>
      </PreferencesProvider>,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Excel export settings' }));
    const fileNameInput = await screen.findByDisplayValue('account-template');
    await user.clear(fileNameInput);
    await user.type(fileNameInput, 'unsaved-template');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Unable to save Excel export settings');
    expect(screen.getByDisplayValue('unsaved-template')).not.toBeNull();
  });
});
