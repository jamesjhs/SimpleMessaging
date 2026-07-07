export const FONT_OPTION_IDS = ['system', 'serif', 'friendly'] as const;

const FONT_OPTION_ID_SET = new Set<string>(FONT_OPTION_IDS);

export function normalizeFontOption(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && FONT_OPTION_ID_SET.has(trimmed) ? trimmed : 'system';
}
