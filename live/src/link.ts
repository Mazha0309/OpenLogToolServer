export interface PublicLink {
  publicShareId: string | null;
  secret: string | null;
}

const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Capture the capability once at module startup and immediately remove it from
 * browser history. It is never copied into storage, React state, logs, or URLs
 * after the one-time WebSocket ticket is issued.
 */
export function consumePublicLink(): PublicLink {
  const marker = '/live/';
  const markerIndex = window.location.pathname.indexOf(marker);
  const pathValue = markerIndex < 0
    ? ''
    : window.location.pathname.slice(markerIndex + marker.length).split('/')[0] ?? '';
  let publicShareId: string | null = null;
  try {
    const decoded = decodeURIComponent(pathValue);
    if (STABLE_ID.test(decoded)) publicShareId = decoded;
  } catch {
    publicShareId = null;
  }

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const candidate = fragment.get('token');
  const secret = candidate && candidate.length >= 32 && candidate.length <= 128
    ? candidate
    : null;

  if (window.location.hash) {
    window.history.replaceState(
      window.history.state,
      document.title,
      `${window.location.pathname}${window.location.search}`,
    );
  }

  return { publicShareId, secret };
}

export const initialPublicLink = consumePublicLink();
