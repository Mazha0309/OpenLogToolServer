import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import PublicArchiveListsPage from './PublicArchiveListsPage';
import { archiveAliasPublicUrl } from '../../utils/publicArchiveUrls';

const archiveApi = vi.hoisted(() => ({ list: vi.fn() }));
const adminArchiveApi = vi.hoisted(() => ({ setAlias: vi.fn(), removeAlias: vi.fn() }));

vi.mock('../../api', () => ({ archiveApi, adminArchiveApi, ApiError: class ApiError extends Error {} }));

describe('admin PublicArchiveListsPage', () => {
  it('sets aliases, surfaces server errors, and copies a root alias URL', async () => {
    archiveApi.list.mockResolvedValue({ items: [{ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: true, alias: null }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    adminArchiveApi.setAlias.mockRejectedValueOnce({ message: 'Archive alias is already taken', code: 'ARCHIVE_ALIAS_TAKEN' }).mockResolvedValue({ id: 'list-1', title: 'Friday Net', alias: 'br5ai' });

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await screen.findByText('Friday Net');
    await user.click(screen.getByRole('button', { name: /set alias/i }));
    await user.type(screen.getByLabelText('Root alias'), 'BR5AI');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByText(/archive alias is already taken/i);
    await user.click(screen.getByRole('button', { name: /save/i }));
    await screen.findByRole('button', { name: /copy public link/i });
    expect(archiveAliasPublicUrl('br5ai')).toBe('/br5ai');
  });
});
