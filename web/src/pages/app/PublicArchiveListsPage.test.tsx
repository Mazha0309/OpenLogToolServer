import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreferencesProvider } from '../../PreferencesContext';
import PublicArchiveListsPage from './PublicArchiveListsPage';
import { archiveAliasPublicUrl, archiveListPublicUrl } from '../../utils/publicArchiveUrls';

const { archiveApi, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
  }
  return {
    archiveApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), publish: vi.fn(), unpublish: vi.fn() },
    ApiError,
  };
});

vi.mock('../../api', () => ({ archiveApi, ApiError }));

const manageable = { canManageContents: true, canManageAccounts: true };

function DetailProbe() {
  const { listId } = useParams();
  return <div>detail route {listId}</div>;
}

function renderPage() {
  return render(<PreferencesProvider><MemoryRouter initialEntries={['/app/public-archives']}><Routes>
    <Route path="/app/public-archives" element={<PublicArchiveListsPage />} />
    <Route path="/app/public-archives/:listId" element={<DetailProbe />} />
  </Routes></MemoryRouter></PreferencesProvider>);
}

describe('PublicArchiveListsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    document.querySelectorAll('.ant-message').forEach((element) => element.remove());
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });
  afterEach(cleanup);

  it('renders owner username, alias tag, and publish state for every list', async () => {
    archiveApi.list.mockResolvedValue({ items: [
      { id: 'list-1', title: 'Aliased net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: true, displayAlias: 'BR5AI', capabilities: manageable },
      { id: 'list-2', title: 'Draft net', ownerUserId: 'owner-2', ownerUsername: 'BD4XYZ', isPublished: false, capabilities: manageable },
    ], page: 1, pageSize: 25, total: 2, totalPages: 1 });

    renderPage();
    const aliased = (await screen.findByText('Aliased net')).closest('tr')!;
    expect(within(aliased).getByText('BA1ABC')).not.toBeNull();
    expect(within(aliased).getByText('BR5AI')).not.toBeNull();
    expect(within(aliased).getByText('Published')).not.toBeNull();
    expect(within(aliased).getByRole('button', { name: /unpublish/i })).not.toBeNull();

    const draft = screen.getByText('Draft net').closest('tr')!;
    expect(within(draft).getByText('BD4XYZ')).not.toBeNull();
    expect(within(draft).getByText('Unpublished')).not.toBeNull();
    expect(within(draft).getByRole('button', { name: /^publish$/i })).not.toBeNull();
    expect(within(draft).queryByRole('button', { name: /copy public link/i })).toBeNull();
  });

  it('copies the alias public address for aliased lists and the internal address otherwise', async () => {
    archiveApi.list.mockResolvedValue({ items: [
      { id: 'list-1', title: 'Aliased net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: true, displayAlias: 'BR5AI', capabilities: manageable },
      { id: 'list-2', title: 'Internal net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: true, capabilities: manageable },
    ], page: 1, pageSize: 25, total: 2, totalPages: 1 });

    renderPage();
    const user = userEvent.setup();
    const aliased = (await screen.findByText('Aliased net')).closest('tr')!;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator.clipboard, 'writeText', { value: writeText, configurable: true });
    await user.click(within(aliased).getByRole('button', { name: /copy public link/i }));
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/BR5AI`);

    const internal = screen.getByText('Internal net').closest('tr')!;
    await user.click(within(internal).getByRole('button', { name: /copy public link/i }));
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/live/list/list-2`);
    expect(archiveAliasPublicUrl('BR5AI')).toBe('/BR5AI');
    expect(archiveListPublicUrl('list-2')).toBe('/live/list/list-2');
  });

  it('publishes and unpublishes directly from the list table', async () => {
    archiveApi.list.mockResolvedValueOnce({ items: [{ id: 'list-1', title: 'Draft net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable }], page: 1, pageSize: 25, total: 1, totalPages: 1 })
      .mockResolvedValueOnce({ items: [{ id: 'list-1', title: 'Draft net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: true, capabilities: manageable }], page: 1, pageSize: 25, total: 1, totalPages: 1 })
      .mockResolvedValue({ items: [{ id: 'list-1', title: 'Draft net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.publish.mockResolvedValue({ id: 'list-1', title: 'Draft net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: true, capabilities: manageable });
    archiveApi.unpublish.mockResolvedValue({ id: 'list-1', title: 'Draft net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable });

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^publish$/i }));

    expect(archiveApi.publish).toHaveBeenCalledWith('list-1');
    const publishedRow = await screen.findByText('Published');
    await user.click(within(publishedRow.closest('tr')!).getByRole('button', { name: /unpublish/i }));
    expect(archiveApi.unpublish).toHaveBeenCalledWith('list-1');
    await screen.findByText('Unpublished');
    expect(screen.queryByText('Published')).toBeNull();
  });

  it('explains that an empty archive list cannot be published', async () => {
    archiveApi.list.mockResolvedValue({ items: [{ id: 'list-1', title: 'Empty net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable }], page: 1, pageSize: 25, total: 1, totalPages: 1 });
    archiveApi.publish.mockRejectedValue(new ApiError(422, 'ARCHIVE_LIST_EMPTY', 'Add at least one archived session before publishing the archive list'));

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^publish$/i }));

    await screen.findByText('Add at least one closed session before publishing this archive list.');
  });

  it('opens the dedicated detail route from the list title', async () => {
    archiveApi.list.mockResolvedValue({ items: [{ id: 'list-1', title: 'Aliased net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: true, displayAlias: 'BR5AI', capabilities: manageable }], page: 1, pageSize: 25, total: 1, totalPages: 1 });

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Aliased net' }));

    await screen.findByText('detail route list-1');
  });

  it('creates an archive list and reloads the table', async () => {
    archiveApi.list.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    archiveApi.create.mockResolvedValue({ id: 'list-1', title: 'Friday Net', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable });

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /create archive/i }));
    await user.type(screen.getByLabelText(/title/i), 'Friday Net');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(archiveApi.create).toHaveBeenCalledWith('Friday Net'));
    await waitFor(() => expect(archiveApi.list).toHaveBeenCalledTimes(2));
  });

  it('requests the selected archive-list page', async () => {
    archiveApi.list.mockResolvedValue({ items: [{ id: 'list-2', title: 'Second page list', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable }], page: 1, pageSize: 25, total: 51, totalPages: 3 });

    renderPage();
    const user = userEvent.setup();
    await screen.findByText('Second page list');
    await user.click(screen.getByRole('listitem', { name: '2' }));

    expect(archiveApi.list).toHaveBeenLastCalledWith({ page: 2, pageSize: 25 });
  });

  it('returns to the previous page after deleting the sole final-page list', async () => {
    archiveApi.list.mockImplementation(({ page }: { page: number }) => Promise.resolve(
      page === 1
        ? { items: [{ id: 'list-1', title: 'First page list', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable }], page: 1, pageSize: 25, total: 26, totalPages: 2 }
        : archiveApi.remove.mock.calls.length
          ? { items: [], page: 2, pageSize: 25, total: 25, totalPages: 1 }
          : { items: [{ id: 'list-26', title: 'Final page list', ownerUserId: 'owner-1', ownerUsername: 'BA1ABC', isPublished: false, capabilities: manageable }], page: 2, pageSize: 25, total: 26, totalPages: 2 },
    ));
    archiveApi.remove.mockResolvedValue({});

    renderPage();
    const user = userEvent.setup();
    await screen.findByText('First page list');
    await user.click(screen.getByRole('listitem', { name: '2' }));
    await screen.findByText('Final page list');
    await user.click(screen.getByText('Final page list').closest('tr')!.querySelector('button.ant-btn-dangerous')!);
    await user.click(await screen.findByRole('button', { name: /^ok$/i }));

    await screen.findByText('First page list');
    expect(archiveApi.remove).toHaveBeenCalledWith('list-26');
    expect(archiveApi.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 25 });
  });
});
