import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import PublicArchiveListsPage from './PublicArchiveListsPage';
import { archiveListPublicUrl } from '../../utils/publicArchiveUrls';

const archiveApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  detail: vi.fn(),
  availableSessions: vi.fn(),
  addSession: vi.fn(),
  refreshSession: vi.fn(),
  removeSession: vi.fn(),
  reorderSessions: vi.fn(),
  publish: vi.fn(),
  remove: vi.fn(),
  members: vi.fn(),
  sources: vi.fn(),
}));

vi.mock('../../api', () => ({ archiveApi, ApiError: class ApiError extends Error {} }));
vi.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner', role: 'user' } }) }));

describe('PublicArchiveListsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });
  afterEach(cleanup);

  it('creates, snapshots, publishes, and copies the internal archive URL', async () => {
    archiveApi.list.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    archiveApi.create.mockResolvedValue({ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: true } });
    archiveApi.detail.mockResolvedValue({ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: true }, sessions: [] });
    archiveApi.availableSessions.mockResolvedValue({ items: [{ source: 'collaboration', sessionId: 'session-1', ownerUserId: 'owner', ownerUsername: 'Owner', title: 'Closed Net', status: 'closed', role: 'owner', logCount: 2, createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T11:00:00Z', closedAt: '2026-08-18T11:00:00Z', deletedAt: null, snapshotRevision: null }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.addSession.mockResolvedValue({ id: 'archive-session-1' });
    archiveApi.publish.mockResolvedValue({ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner', isPublished: true, capabilities: { canManageContents: true, canManageAccounts: true } });
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

  it('replaces selected list state when detail reloads', async () => {
    const initial = {
      id: 'list-1', title: 'Original title', ownerUserId: 'owner', isPublished: false, displayAlias: 'OLD',
      capabilities: { canManageContents: true, canManageAccounts: true },
      sessions: [{ id: 'session-old', listId: 'list-1', sourceUserId: 'owner', sourceKind: 'collaboration' as const, sourceSessionId: 'source-old', title: 'Old session', closedAt: '2026-08-18T10:00:00Z', displayOrder: 0, logCount: 1, snapshotAt: '2026-08-18T10:00:00Z' }],
    };
    const refreshed = {
      ...initial, title: 'Refreshed title', isPublished: true, displayAlias: 'NEW',
      capabilities: { canManageContents: false, canManageAccounts: false },
      sessions: [{ ...initial.sessions[0], id: 'session-new', title: 'New session' }],
    };
    archiveApi.list.mockResolvedValue({ items: [initial], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.detail.mockResolvedValue(refreshed);
    archiveApi.availableSessions.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    archiveApi.members.mockResolvedValue([]); archiveApi.sources.mockResolvedValue([]);

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Original title' }));

    await screen.findByText('Refreshed title');
    await screen.findByText('New session');
    expect(screen.queryByText('Old session')).toBeNull();
    expect(screen.getByRole('button', { name: /unpublish/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /add closed session/i })).toBeNull();
  });

  it('lets list members manage snapshots without exposing account management', async () => {
    const list = {
      id: 'list-1', title: 'Member list', ownerUserId: 'owner', isPublished: false,
      capabilities: { canManageContents: true, canManageAccounts: false },
      sessions: [{ id: 'snapshot-1', listId: 'list-1', sourceUserId: 'owner', sourceKind: 'collaboration' as const, sourceSessionId: 'source-1', title: 'Snapshot', closedAt: '2026-08-18T10:00:00Z', displayOrder: 0, logCount: 1, snapshotAt: '2026-08-18T10:00:00Z' }],
    };
    archiveApi.list.mockResolvedValue({ items: [list], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.detail.mockResolvedValue(list);
    archiveApi.availableSessions.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Member list' }));

    await screen.findByRole('button', { name: /add closed session/i });
    const snapshotRow = screen.getByText('Snapshot').closest('tr')!;
    expect(within(snapshotRow).getByRole('button', { name: /^refresh$/i })).not.toBeNull();
    expect(within(snapshotRow).getByRole('button', { name: /move up/i })).not.toBeNull();
    expect(within(snapshotRow).getByRole('button', { name: /^delete$/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /manage members and sources/i })).toBeNull();
    expect(screen.queryByText(/members and sources can be managed/i)).toBeNull();
  });

  it('requests filtered session pages and renders the server total', async () => {
    const list = { id: 'list-1', title: 'Paged list', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: false }, sessions: [] };
    archiveApi.list.mockResolvedValue({ items: [list], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.detail.mockResolvedValue(list);
    archiveApi.availableSessions.mockResolvedValue({ items: [{ source: 'collaboration', sessionId: 'session-1', ownerUserId: 'owner', ownerUsername: 'Owner', title: 'Filtered session', status: 'closed', role: 'owner', logCount: 2, createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T11:00:00Z', closedAt: '2026-08-18T11:00:00Z', deletedAt: null, snapshotRevision: null }], page: 1, pageSize: 25, total: 51, totalPages: 3 });

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Paged list' }));
    await user.click(await screen.findByRole('button', { name: /add closed session/i }));
    const picker = screen.getByRole('dialog');
    await user.click(within(picker).getAllByRole('combobox')[0]);
    await user.click(await screen.findByText('Collaboration'));
    await screen.findByText('Filtered session');
    expect(archiveApi.availableSessions).toHaveBeenLastCalledWith('list-1', { page: 1, pageSize: 25, source: 'collaboration' });
    expect(within(picker).getByRole('listitem', { name: '3' })).not.toBeNull();
    await user.click(within(picker).getByRole('listitem', { name: '2' }));
    expect(archiveApi.availableSessions).toHaveBeenLastCalledWith('list-1', { page: 2, pageSize: 25, source: 'collaboration' });
  });

  it('requests the selected main archive-list page', async () => {
    archiveApi.list.mockResolvedValue({ items: [{ id: 'list-2', title: 'Second page list', ownerUserId: 'owner', isPublished: false }], page: 1, pageSize: 25, total: 51, totalPages: 3 });

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await screen.findByText('Second page list');
    await user.click(screen.getByRole('listitem', { name: '2' }));

    expect(archiveApi.list).toHaveBeenLastCalledWith({ page: 2, pageSize: 25 });
  });

  it('replaces snapshot state after refresh, reorder, and removal', async () => {
    const list = { id: 'list-1', title: 'Mutable list', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: false } };
    const initial = [{ id: 'snapshot-a', listId: 'list-1', sourceUserId: 'owner', sourceKind: 'collaboration' as const, sourceSessionId: 'source-a', title: 'Stale A', closedAt: '2026-08-18T10:00:00Z', displayOrder: 0, logCount: 1, snapshotAt: '2026-08-18T10:00:00Z' }, { id: 'snapshot-b', listId: 'list-1', sourceUserId: 'owner', sourceKind: 'collaboration' as const, sourceSessionId: 'source-b', title: 'Stale B', closedAt: '2026-08-18T10:00:00Z', displayOrder: 1, logCount: 1, snapshotAt: '2026-08-18T10:00:00Z' }];
    archiveApi.list.mockResolvedValue({ items: [{ ...list, sessions: initial }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.detail.mockResolvedValueOnce({ ...list, sessions: initial })
      .mockResolvedValueOnce({ ...list, sessions: [{ ...initial[0], title: 'Refreshed A' }, { ...initial[1], title: 'Refreshed B' }] })
      .mockResolvedValueOnce({ ...list, sessions: [{ ...initial[1], title: 'Reordered first' }, { ...initial[0], title: 'Reordered second' }] })
      .mockResolvedValueOnce({ ...list, sessions: [] });
    archiveApi.availableSessions.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    archiveApi.refreshSession.mockResolvedValue({}); archiveApi.reorderSessions.mockResolvedValue({}); archiveApi.removeSession.mockResolvedValue({});

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mutable list' }));
    let snapshotRow = (await screen.findByText('Stale A')).closest('tr')!;
    await user.click(within(snapshotRow).getByRole('button', { name: /^refresh$/i }));
    await screen.findByText('Refreshed A');
    expect(screen.queryByText('Stale A')).toBeNull();
    snapshotRow = screen.getByText('Refreshed A').closest('tr')!;
    await user.click(within(snapshotRow).getByRole('button', { name: /move down/i }));
    await screen.findByText('Reordered first');
    expect(screen.queryByText('Refreshed A')).toBeNull();
    snapshotRow = screen.getByText('Reordered first').closest('tr')!;
    await user.click(within(snapshotRow).getByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));
    await screen.findByText(/no archived sessions/i);
    expect(screen.queryByText('Reordered first')).toBeNull();
  });

  it('clears selected archive state and dependent modals after deleting that list', async () => {
    const list = { id: 'list-1', title: 'Deleted list', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: true }, sessions: [{ id: 'snapshot-1', listId: 'list-1', sourceUserId: 'owner', sourceKind: 'collaboration' as const, sourceSessionId: 'source-1', title: 'Stale snapshot', closedAt: '2026-08-18T10:00:00Z', displayOrder: 0, logCount: 1, snapshotAt: '2026-08-18T10:00:00Z' }] };
    archiveApi.list.mockResolvedValueOnce({ items: [list], page: 1, pageSize: 25, total: 1, totalPages: 1 }).mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    archiveApi.detail.mockResolvedValue(list);
    archiveApi.availableSessions.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    archiveApi.members.mockResolvedValue([]); archiveApi.sources.mockResolvedValue([]); archiveApi.remove.mockResolvedValue({});

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deleted list' }));
    await screen.findByText('Stale snapshot');
    await user.click(screen.getByRole('button', { name: /manage members and sources/i }));
    expect(screen.getByRole('dialog', { name: /manage members and sources/i })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Deleted list' }).closest('tr')!.querySelector('button.ant-btn-dangerous')!);
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    await screen.findAllByText('No data');
    expect(screen.queryByText('Deleted list')).toBeNull();
    expect(screen.queryByText('Stale snapshot')).toBeNull();
    expect(screen.queryByRole('button', { name: /add closed session/i })).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /manage members and sources/i })).toBeNull());
  });

  it('clears stale detail state when the selected archive no longer loads', async () => {
    const list = { id: 'list-1', title: 'Unavailable list', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: false }, sessions: [{ id: 'snapshot-1', listId: 'list-1', sourceUserId: 'owner', sourceKind: 'collaboration' as const, sourceSessionId: 'source-1', title: 'Stale snapshot', closedAt: '2026-08-18T10:00:00Z', displayOrder: 0, logCount: 1, snapshotAt: '2026-08-18T10:00:00Z' }] };
    archiveApi.list.mockResolvedValue({ items: [list], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.detail.mockRejectedValue(new Error('not found'));
    archiveApi.availableSessions.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Unavailable list' }));

    await screen.findByText('Unavailable list');
    expect(screen.queryByText('Stale snapshot')).toBeNull();
    expect(screen.queryByRole('button', { name: /add closed session/i })).toBeNull();
  });

  it('returns to the previous page after deleting the sole final-page list', async () => {
    const finalPageList = { id: 'list-26', title: 'Final page list', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: false } };
    const firstPageList = { id: 'list-1', title: 'First page list', ownerUserId: 'owner', isPublished: false, capabilities: { canManageContents: true, canManageAccounts: false } };
    archiveApi.list.mockImplementation(({ page }: { page: number }) => Promise.resolve(
      page === 1
        ? { items: [firstPageList], page: 1, pageSize: 25, total: 26, totalPages: 2 }
        : archiveApi.remove.mock.calls.length
          ? { items: [], page: 2, pageSize: 25, total: 25, totalPages: 1 }
          : { items: [finalPageList], page: 2, pageSize: 25, total: 26, totalPages: 2 },
    ));
    archiveApi.detail.mockResolvedValue(finalPageList); archiveApi.remove.mockResolvedValue({});
    archiveApi.availableSessions.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });

    render(<PreferencesProvider><PublicArchiveListsPage /></PreferencesProvider>);
    const user = userEvent.setup();
    await screen.findByText('First page list');
    await user.click(screen.getByRole('listitem', { name: '2' }));
    await screen.findByText('Final page list');
    await user.click(screen.getByRole('button', { name: 'Final page list' }));
    await user.click(screen.getByRole('button', { name: 'Final page list' }).closest('tr')!.querySelector('button.ant-btn-dangerous')!);
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    await screen.findByText('First page list');
    expect(archiveApi.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 25 });
  });
});
