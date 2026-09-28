/**
 * R13 keyset pagination for newest-first lists: the cursor is the (createdAt, id) of the
 * last row returned, so pages stay stable while new rows arrive (unlike offsets).
 */
export interface PageCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString('base64url');
}

/** Undefined for a missing or malformed cursor (which then means "first page"). */
export function decodeCursor(value: unknown): PageCursor | undefined {
  if (typeof value !== 'string' || !value || value.length > 300) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [createdAt, id] = parsed as [unknown, unknown];
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return undefined;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

/** A page plus the cursor for the next one (only when this page is full). */
export function page<T extends { createdAt: string; id: string }>(
  entries: T[],
  limit: number,
): { entries: T[]; nextCursor?: string } {
  const last = entries.at(-1);
  return {
    entries,
    nextCursor: entries.length >= limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined,
  };
}
