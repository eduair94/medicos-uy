const LEADING_HONORIFIC =
  /^(?:(?:dr|dra|doctor|doctora|prof|profesora?|lic|licenciada?|tec|tecnica?|q\s*\.?\s*f)\.?\s+)+/iu;

function removeDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '');
}

function reorderSurnameFirst(value: string): string {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length !== 2) {
    return value;
  }

  const [surname, givenNames] = parts;
  if (surname === undefined || givenNames === undefined) {
    return value;
  }

  return `${givenNames} ${surname}`;
}

/**
 * Produces a conservative comparison key. It handles formatting differences but
 * deliberately keeps every name token: dropping middle names or second surnames
 * would create unsafe identity links.
 */
export function normalizePersonName(value: string): string {
  const withoutParentheticalNotes = value.replace(/\([^)]*\)/gu, ' ');
  const withoutHonorific = removeDiacritics(
    withoutParentheticalNotes.replace(/\u00a0/gu, ' ').trim(),
  ).replace(LEADING_HONORIFIC, '');
  const reordered = reorderSurnameFirst(withoutHonorific);

  return reordered
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}
