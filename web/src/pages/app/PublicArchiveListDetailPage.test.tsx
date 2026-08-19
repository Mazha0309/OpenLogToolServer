import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import PublicArchiveListDetailPage from './PublicArchiveListDetailPage';

const { archiveApi, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
  }
  return {
    archiveApi: {
      detail: vi.fn(), availableSessions: vi.fn(), addSession: vi.fn(), refreshSession: vi.fn(),
      removeSession: vi.fn(), reorderSessions: vi.fn(), members: vi.fn(), sources: vi.fn(),
      addMember: vi.fn(), addSource: vi.fn(), removeMember: vi.fn(), removeSource: vi.fn(),
      candidateAccounts: vi.fn(), addMemberByUsername: vi.fn(), addSourceByUsername: vi.fn(),
    },
    ApiError,
  };
});

vi.mock('../../api', () => ({ archiveApi, ApiError }));

function snapshot(id: string, title: string, displayOrder: number) {
  return { id, listId: 'list-1', sourceUserId: 'owner-1', sourceKind: 'collaboration' as const, sourceSessionId: `source-${id}`, title, closedAt: '2026-08-18T10:00:00Z', displayOrder, logCount: 3, snapshotAt: '2026-08-18T10:00:00Z' };
}

function detailPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'list-1', title: 'Friday Net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: true, displayAlias: 'BR5AI',
    capabilities: { canManageContents: true, canManageAccounts: true },
    sessions: [snapshot('snapshot-a', 'Snapshot A', 0), snapshot('snapshot-b', 'Snapshot B', 1)],
    ...overrides,
  };
}

function renderPage() {
  return render(<PreferencesProvider><MemoryRouter initialEntries={['/app/public-archives/list-1']}><Routes>
    <Route path="/app/public-archives" element={<div>overview route</div>} />
    <Route path="/app/public-archives/:listId" element={<PublicArchiveListDetailPage />} />
  </Routes></MemoryRouter></PreferencesProvider>);
}

const emptyPage = { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 };

describe('PublicArchiveListDetailPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    document.querySelectorAll('.ant-message').forEach((element) => element.remove());
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    archiveApi.availableSessions.mockResolvedValue(emptyPage);
    archiveApi.candidateAccounts.mockResolvedValue(emptyPage);
    archiveApi.members.mockResolvedValue([]);
    archiveApi.sources.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('renders the list identity, public address, and snapshots', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload());

    renderPage();
    await screen.findByText('Friday Net');
    expect(archiveApi.detail).toHaveBeenCalledWith('list-1');
    expect(screen.getByText('BA1ABC')).not.toBeNull();
    expect(screen.getByText('Published')).not.toBeNull();
    expect(screen.getByText('BR5AI')).not.toBeNull();
    expect(screen.getByRole('link', { name: /back to archive lists/i }).getAttribute('href')).toBe('/app/public-archives');
    expect(screen.getByRole('link', { name: /open public page/i }).getAttribute('href')).toBe('/BR5AI');
    await screen.findByText('Snapshot A');
    expect(screen.getByText('Snapshot B')).not.toBeNull();
  });

  it('copies the resolved internal public address when no alias exists', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload({ displayAlias: undefined }));

    renderPage();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator.clipboard, 'writeText', { value: writeText, configurable: true });
    await user.click(await screen.findByRole('button', { name: /copy public link/i }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/live/list/list-1`);
  });

  it('hides the account section for members that cannot manage accounts', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload({ capabilities: { canManageContents: true, canManageAccounts: false } }));

    renderPage();
    await screen.findByText('Snapshot A');
    expect(screen.queryByText('Members')).toBeNull();
    expect(screen.queryByText('Source accounts')).toBeNull();
    expect(archiveApi.members).not.toHaveBeenCalled();
    expect(archiveApi.sources).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /add closed session/i })).not.toBeNull();
  });

  it('lists member and source usernames when account management is allowed', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload());
    archiveApi.members.mockResolvedValue([{ userId: 'user-9', username: 'BG7MEM' }]);
    archiveApi.sources.mockResolvedValue([{ userId: 'user-4', username: 'BH8SRC' }]);

    renderPage();
    await screen.findByText('Members');
    expect(await screen.findByText('BG7MEM')).not.toBeNull();
    expect(await screen.findByText('BH8SRC')).not.toBeNull();
    expect(screen.queryByText('user-9')).toBeNull();
  });

  it('searches candidate accounts on the server and adds the chosen account by id', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload());
    archiveApi.candidateAccounts.mockResolvedValue({ items: [{ userId: 'user-7', username: 'BC3CAN' }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.addMember.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    const membersCard = (await screen.findByText('Members')).closest('.ant-card') as HTMLElement;
    await user.click(within(membersCard).getByRole('combobox'));
    await user.type(within(membersCard).getByRole('combobox'), 'bc3');
    await waitFor(() => expect(archiveApi.candidateAccounts).toHaveBeenLastCalledWith('list-1', { kind: 'members', page: 1, pageSize: 25, q: 'bc3' }));
    await user.click(await screen.findByTitle('BC3CAN'));
    await user.click(within(membersCard).getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(archiveApi.addMember).toHaveBeenCalledWith('list-1', 'user-7'));
  });

  it('does not reuse a member candidate when adding a source account', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload());
    archiveApi.candidateAccounts.mockImplementation((_listId: string, { kind }: { kind: string }) => Promise.resolve({
      items: [{ userId: kind === 'members' ? 'member-1' : 'source-1', username: kind === 'members' ? 'MEMBER' : 'SOURCE' }],
      page: 1, pageSize: 25, total: 1, totalPages: 1,
    }));
    archiveApi.addSource.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    const membersCard = (await screen.findByText('Members')).closest('.ant-card') as HTMLElement;
    const sourcesCard = (await screen.findByText('Source accounts')).closest('.ant-card') as HTMLElement;
    await user.click(within(membersCard).getByRole('combobox'));
    await user.type(within(membersCard).getByRole('combobox'), 'member');
    await user.click(await screen.findByTitle('MEMBER'));
    await user.click(within(sourcesCard).getByRole('button', { name: /^add$/i }));

    expect(archiveApi.addSource).not.toHaveBeenCalled();
    expect(within(sourcesCard).getByRole('button', { name: /^add$/i }).getAttribute('disabled')).not.toBeNull();

    await user.click(within(sourcesCard).getByRole('combobox'));
    await user.type(within(sourcesCard).getByRole('combobox'), 'source');
    await user.click(await screen.findByTitle('SOURCE'));
    await user.click(within(sourcesCard).getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(archiveApi.addSource).toHaveBeenCalledWith('list-1', 'source-1'));
    expect(archiveApi.addSource).not.toHaveBeenCalledWith('list-1', 'member-1');
  });

  it('adds a source account by exact username and reports USER_NOT_FOUND', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload());
    archiveApi.addSourceByUsername.mockRejectedValue(new ApiError(404, 'USER_NOT_FOUND', 'An active target user is required'));

    renderPage();
    const user = userEvent.setup();
    const sourcesCard = (await screen.findByText('Source accounts')).closest('.ant-card') as HTMLElement;
    await user.type(within(sourcesCard).getByLabelText(/add by exact username/i), 'GHOST');
    await user.click(within(sourcesCard).getByRole('button', { name: /add username/i }));

    await waitFor(() => expect(archiveApi.addSourceByUsername).toHaveBeenCalledWith('list-1', 'GHOST'));
    await screen.findByText('An active target user is required (USER_NOT_FOUND)');
  });

  it('adds a closed session from the paginated picker filtered by source', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload({ sessions: [] }));
    archiveApi.availableSessions.mockResolvedValue({ items: [{ source: 'collaboration', sessionId: 'session-1', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', title: 'Closed Net', status: 'closed', role: 'owner', logCount: 2, createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T11:00:00Z', closedAt: '2026-08-18T11:00:00Z', deletedAt: null, snapshotRevision: null }], page: 1, pageSize: 25, total: 51, totalPages: 3 });
    archiveApi.addSession.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /add closed session/i }));
    const picker = screen.getByRole('dialog');
    await user.click(within(picker).getAllByRole('combobox')[0]);
    await user.click(await screen.findByTitle('Collaboration'));
    await waitFor(() => expect(archiveApi.availableSessions).toHaveBeenLastCalledWith('list-1', { page: 1, pageSize: 25, source: 'collaboration' }));
    await user.click(within(picker).getByRole('listitem', { name: '2' }));
    await waitFor(() => expect(archiveApi.availableSessions).toHaveBeenLastCalledWith('list-1', { page: 2, pageSize: 25, source: 'collaboration' }));
    await user.click(within(screen.getByRole('dialog')).getByText('Closed Net').closest('tr')!.querySelector('input[type="radio"]')!);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(archiveApi.addSession).toHaveBeenCalledWith('list-1', { sourceUserId: 'owner-1', sourceKind: 'collaboration', sourceSessionId: 'session-1' }));
    await waitFor(() => expect(archiveApi.detail).toHaveBeenCalledTimes(2));
  });

  it('clears a selected session when the source filter changes and when the picker reopens', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload({ sessions: [] }));
    archiveApi.availableSessions.mockImplementation((_listId: string, { source }: { source?: string }) => Promise.resolve({
      items: source === 'collaboration' ? [{ source: 'collaboration', sessionId: 'collab-1', ownerUserId: 'owner-2', ownerUsername: 'COLLAB', title: 'Collab Net', status: 'closed', role: 'owner', logCount: 2, createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T11:00:00Z', closedAt: '2026-08-18T11:00:00Z', deletedAt: null, snapshotRevision: null }] : [{ source: 'personal', sessionId: 'personal-1', ownerUserId: 'owner-1', ownerUsername: 'PERSONAL', title: 'Personal Net', status: 'closed', role: 'owner', logCount: 2, createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T11:00:00Z', closedAt: '2026-08-18T11:00:00Z', deletedAt: null, snapshotRevision: null }],
      page: 1, pageSize: 25, total: 1, totalPages: 1,
    }));
    archiveApi.addSession.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /add closed session/i }));
    let picker = screen.getByRole('dialog');
    await user.click(within(picker).getAllByRole('combobox')[0]);
    await user.click(await screen.findByTitle('Personal'));
    await user.click((await screen.findByText('Personal Net')).closest('tr')!.querySelector('input[type="radio"]')!);
    await user.click(within(picker).getAllByRole('combobox')[0]);
    await user.click(await screen.findByTitle('Collaboration'));
    picker = screen.getByRole('dialog');
    await waitFor(() => expect(within(picker).getByRole('button', { name: /^add$/i }).getAttribute('disabled')).not.toBeNull());
    await user.click(within(picker).getByRole('button', { name: /^add$/i }));
    expect(archiveApi.addSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await user.click(await screen.findByRole('button', { name: /add closed session/i }));
    picker = screen.getByRole('dialog');
    expect(within(picker).getByRole('button', { name: /^add$/i }).getAttribute('disabled')).not.toBeNull();
  });

  it('reloads authoritative snapshots after refresh, reorder, and removal', async () => {
    archiveApi.detail.mockResolvedValueOnce(detailPayload())
      .mockResolvedValueOnce(detailPayload({ sessions: [snapshot('snapshot-a', 'Refreshed A', 0), snapshot('snapshot-b', 'Snapshot B', 1)] }))
      .mockResolvedValueOnce(detailPayload({ sessions: [snapshot('snapshot-b', 'Reordered first', 0), snapshot('snapshot-a', 'Reordered second', 1)] }))
      .mockResolvedValue(detailPayload({ sessions: [] }));
    archiveApi.refreshSession.mockResolvedValue({});
    archiveApi.reorderSessions.mockResolvedValue({});
    archiveApi.removeSession.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    let row = (await screen.findByText('Snapshot A')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /^refresh$/i }));
    expect(archiveApi.refreshSession).toHaveBeenCalledWith('list-1', 'snapshot-a');
    await screen.findByText('Refreshed A');

    row = screen.getByText('Refreshed A').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /move down/i }));
    expect(archiveApi.reorderSessions).toHaveBeenCalledWith('list-1', ['snapshot-b', 'snapshot-a']);
    await screen.findByText('Reordered first');

    row = screen.getByText('Reordered first').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));
    expect(archiveApi.removeSession).toHaveBeenCalledWith('list-1', 'snapshot-b');
    await screen.findByText('No archived sessions');
  }, 20_000);

  it('moves a non-first snapshot up with the full ordered list', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload());
    archiveApi.reorderSessions.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    const row = (await screen.findByText('Snapshot B')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /move up/i }));

    expect(archiveApi.reorderSessions).toHaveBeenCalledWith('list-1', ['snapshot-b', 'snapshot-a']);
  });

  it('moves a non-final snapshot down with the full ordered list', async () => {
    archiveApi.detail.mockResolvedValue(detailPayload());
    archiveApi.reorderSessions.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    const row = (await screen.findByText('Snapshot A')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /move down/i }));

    expect(archiveApi.reorderSessions).toHaveBeenCalledWith('list-1', ['snapshot-b', 'snapshot-a']);
  });

  it('renders the standard error state when the archive list is missing', async () => {
    archiveApi.detail.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Archive list was not found'));

    renderPage();
    await screen.findByText('Could not load data');
    expect(screen.getByText('This item does not exist or is not visible to you.')).not.toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).not.toBeNull();
  });

  it('renders the standard error state when detail access is forbidden', async () => {
    archiveApi.detail.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Archive list management is forbidden'));

    renderPage();
    await screen.findByText('Could not load data');
    expect(screen.getByText('Your account cannot perform this action.')).not.toBeNull();
  });
});
