export function archiveListPublicUrl(listId: string): string {
  return `/live/list/${encodeURIComponent(listId)}`;
}

export function archiveAliasPublicUrl(alias: string): string {
  return `/${alias}`;
}
