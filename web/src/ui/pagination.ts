/** Shared six-record pagination contract for bounded list/search surfaces.
 * Keep windowing on the server whenever the API supports limit/offset.
 */
export const DEFAULT_LIST_PAGE_SIZE = 6;

export function listPageSize(value = DEFAULT_LIST_PAGE_SIZE): number {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_LIST_PAGE_SIZE;
}

export function normalizeListOffset(value: number, pageSize = DEFAULT_LIST_PAGE_SIZE): number {
  const size = listPageSize(pageSize);
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.floor(value / size) * size;
}

export function lastListPageOffset(total: number, pageSize = DEFAULT_LIST_PAGE_SIZE): number {
  const size = listPageSize(pageSize);
  if (!Number.isSafeInteger(total) || total < 1) return 0;
  return Math.floor((total - 1) / size) * size;
}

export function listPageCount(total: number, pageSize = DEFAULT_LIST_PAGE_SIZE): number {
  const size = listPageSize(pageSize);
  return Number.isSafeInteger(total) && total > 0 ? Math.ceil(total / size) : 1;
}

export function listPageNumber(offset: number, total: number, pageSize = DEFAULT_LIST_PAGE_SIZE): number {
  const size = listPageSize(pageSize);
  return Math.floor(Math.min(normalizeListOffset(offset, size), lastListPageOffset(total, size)) / size) + 1;
}

export function listOffsetForPage(page: number, total: number, pageSize = DEFAULT_LIST_PAGE_SIZE): number {
  const size = listPageSize(pageSize);
  if (!Number.isSafeInteger(page) || page < 1) return 0;
  const lastPage = listPageCount(total, size);
  return (Math.min(page, lastPage) - 1) * size;
}
