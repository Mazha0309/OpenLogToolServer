import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import PublicArchiveListsPage from './PublicArchiveListsPage';
import { archiveListPublicUrl } from '../../utils/publicArchiveUrls';

const archiveApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  detail: vi.fn(),
  availableSessions: vi.fn(),
  addSession: vi.fn(),
  publish: vi.fn(),
  members: vi.fn(),
  sources: vi.fn(),
}));

vi.mock('../../api', () => ({ archiveApi, ApiError: class ApiError extends Error {} }));
vi.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner', role: 'user' } }) }));

describe('PublicArchiveListsPage', () => {
  it('creates, snapshots, publishes, and copies the internal archive URL', async () => {
    archiveApi.list.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    archiveApi.create.mockResolvedValue({ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: false });
    archiveApi.detail.mockResolvedValue({ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: false, sessions: [] });
    archiveApi.availableSessions.mockResolvedValue({ items: [{ source: 'collaboration', sessionId: 'session-1', ownerUserId: 'owner', ownerUsername: 'Owner', title: 'Closed Net', status: 'closed', role: 'owner', logCount: 2, createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T11:00:00Z', closedAt: '2026-08-18T11:00:00Z', deletedAt: null, snapshotRevision: null }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.addSession.mockResolvedValue({ id: 'archive-session-1' });
    archiveApi.publish.mockResolvedValue({ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: true });
    archiveApi.members.mockResolvedValue([]); archiveApi.sources.mockResolvedValue([]);

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /create archive/i }));
    await user.type(screen.getByLabelText(/title/i), 'Friday Net');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Friday Net');
    await user.click(await screen.findByRole('button', { name: /add closed session/i }));
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('button', { name: /publish/i }));
    await screen.findByRole('button', { name: /copy public link/i });
    expect(archiveListPublicUrl('list-1')).toBe('/live/list/list-1');
  });
});
