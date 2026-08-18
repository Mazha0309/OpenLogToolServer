import type { ArchiveDirectory, ArchiveSessionDetail } from './types';

export type ArchiveRoute =
  | { kind: 'list'; listId?: string; alias?: string }
  | { kind: 'session'; listId?: string; alias?: string; archiveSessionId: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const RESERVED_ROOT_PATHS = new Set([
  'api', 'admin', 'app', 'assets', 'bootstrap', 'favicon.ico', 'health', 'live',
  'login', 'register', 'robots.txt', 'web', 'ws',
]);

function decoded(value: string): string | null {
  try {
    const result = decodeURIComponent(value);
    return result.includes('/') ? null : result;
  } catch {
    return null;
  }
}

export function parseArchiveRoute(pathname: string): ArchiveRoute | null {
  const segments = pathname.split('/').filter(Boolean).map(decoded);
  if (segments.some((segment) => !segment)) return null;
  const [first, second, third, fourth] = segments as string[];

  if (first === 'live' && second === 'list' && ID.test(third ?? '')) {
    if (!fourth) return { kind: 'list', listId: third };
    if (fourth === 'session' && ID.test(segments[4] ?? '') && segments.length === 5) {
      return { kind: 'session', listId: third, archiveSessionId: segments[4]! };
    }
    return null;
  }

  if (segments.length === 1 && first && ALIAS.test(first) && !RESERVED_ROOT_PATHS.has(first.toLowerCase())) {
    return { kind: 'list', alias: first };
  }
  if (segments.length === 3 && first && second === 'session' && ID.test(third ?? '')
    && ALIAS.test(first) && !RESERVED_ROOT_PATHS.has(first.toLowerCase())) {
    return { kind: 'session', alias: first, archiveSessionId: third! };
  }
  return null;
}

export function archivePath(route: ArchiveRoute): string {
  const root = route.alias ? `/${encodeURIComponent(route.alias)}` : `/live/list/${encodeURIComponent(route.listId!)}`;
  return route.kind === 'session' ? `${root}/session/${encodeURIComponent(route.archiveSessionId)}` : root;
}

export async function fetchArchive(route: ArchiveRoute): Promise<ArchiveDirectory | ArchiveSessionDetail> {
  const base = route.alias
    ? `/api/v1/public/archive-aliases/${encodeURIComponent(route.alias)}`
    : `/api/v1/public/archive-lists/${encodeURIComponent(route.listId!)}`;
  const response = await fetch(route.kind === 'session' ? `${base}/sessions/${encodeURIComponent(route.archiveSessionId)}` : base);
  if (!response.ok) throw new Error(`Archive request failed (${response.status})`);
  const body = await response.json() as { data?: ArchiveDirectory | ArchiveSessionDetail };
  if (!body.data) throw new Error('Archive response is invalid');
  return body.data;
}
