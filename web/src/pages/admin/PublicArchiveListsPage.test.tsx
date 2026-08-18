import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import PublicArchiveListsPage from './PublicArchiveListsPage';
import { archiveAliasPublicUrl } from '../../utils/publicArchiveUrls';

const { archiveApi, adminArchiveApi, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    readonly code: string;
    constructor(message: string, code: string) { super(message); this.code = code; }
  }
  return { archiveApi: { list: vi.fn() }, adminArchiveApi: { setAlias: vi.fn(), removeAlias: vi.fn() }, ApiError };
});

vi.mock('../../api', () => ({ archiveApi, adminArchiveApi, ApiError }));

describe('admin PublicArchiveListsPage', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(cleanup);

  it('copies the reloaded display alias as a full public URL', async () => {
    archiveApi.list.mockResolvedValueOnce({ items: [{ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: true, displayAlias: 'OLD' }], page: 1, pageSize: 25, total: 1, totalPages: 1 })
      .mockResolvedValueOnce({ items: [{ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: true, displayAlias: 'BR5AI' }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    adminArchiveApi.setAlias.mockResolvedValue({ id: 'list-1', title: 'Friday Net', displayAlias: 'BR5AI' });

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await screen.findByText('Friday Net');
    await user.click(screen.getByRole('button', { name: /replace alias/i }));
    await user.type(screen.getByLabelText('Root alias'), 'BR5AI');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByText('BR5AI');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator.clipboard, 'writeText', { value: writeText, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: /copy public link/i }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/BR5AI`);
    expect(archiveAliasPublicUrl('BR5AI')).toBe('/BR5AI');
  });

  it.each([
    ['ARCHIVE_ALIAS_TAKEN', 'Archive alias is already taken'],
    ['ARCHIVE_ALIAS_INVALID', 'Archive alias is reserved'],
  ])('displays the %s alias error', async (code, message) => {
    archiveApi.list.mockResolvedValue({ items: [{ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: true }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    adminArchiveApi.setAlias.mockRejectedValue(new ApiError(message, code));

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /set alias/i }));
    await user.type(screen.getByLabelText('Root alias'), 'reserved');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await screen.findByText(`${message} (${code})`);
  });
});
