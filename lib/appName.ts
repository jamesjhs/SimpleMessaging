import { getSetting } from '../db';

export const DEFAULT_APP_NAME = 'Messaging';

export function normalizeAppName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'TLS' ? trimmed : DEFAULT_APP_NAME;
}

export function getAppName(): string {
  return normalizeAppName(getSetting('site_title'));
}

export function getMainHeader(): string {
  const header = getSetting('main_header')?.trim();
  return header && header !== 'TLS' ? header : getAppName();
}
