export const COLOUR_SCHEME_IDS = [
  'default',
  'ocean',
  'purple',
  'warm',
  'forest',
  'midnight',
  'rose',
  'sage',
  'steel',
  'sunset',
] as const;

const COLOUR_SCHEME_ID_SET = new Set<string>(COLOUR_SCHEME_IDS);

export function parseAvailableColourSchemes(value: string | null | undefined): string[] {
  const ids = (value ?? COLOUR_SCHEME_IDS.join(','))
    .split(',')
    .map(id => id.trim())
    .filter(id => COLOUR_SCHEME_ID_SET.has(id));

  return ids.length > 0 ? [...new Set(ids)] : ['default'];
}

export function isColourSchemeAvailable(id: string, availableValue: string | null | undefined): boolean {
  return parseAvailableColourSchemes(availableValue).includes(id);
}
