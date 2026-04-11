import type { AccountConfig } from '@cat-cafe/shared';
import { readCatalogAccounts } from './catalog-accounts.js';

function normalizeModels(models: readonly string[] | undefined): string[] {
  if (!models) return [];
  return [...new Set(models.map((value) => value.trim()).filter(Boolean))].sort();
}

function canonicalize(account: AccountConfig) {
  return {
    authType: account.authType,
    protocol: account.protocol,
    baseUrl: account.baseUrl?.trim().replace(/\/+$/, '') ?? '',
    displayName: account.displayName?.trim() ?? '',
    models: normalizeModels(account.models),
  };
}

export function validateAccountWrite(projectRoot: string, accountRef: string, next: AccountConfig): void {
  const existing = readCatalogAccounts(projectRoot)[accountRef];
  if (!existing) return;

  const currentCanonical = canonicalize(existing);
  const nextCanonical = canonicalize(next);
  if (JSON.stringify(currentCanonical) === JSON.stringify(nextCanonical)) return;

  const diffs: string[] = [];
  if (currentCanonical.authType !== nextCanonical.authType) {
    diffs.push(`authType ${currentCanonical.authType} vs ${nextCanonical.authType}`);
  }
  if (currentCanonical.protocol !== nextCanonical.protocol) {
    diffs.push(`protocol ${currentCanonical.protocol} vs ${nextCanonical.protocol}`);
  }
  if (currentCanonical.baseUrl !== nextCanonical.baseUrl) {
    diffs.push(`baseUrl ${currentCanonical.baseUrl || '(none)'} vs ${nextCanonical.baseUrl || '(none)'}`);
  }
  if (currentCanonical.displayName !== nextCanonical.displayName) {
    diffs.push(`displayName ${currentCanonical.displayName || '(none)'} vs ${nextCanonical.displayName || '(none)'}`);
  }
  if (JSON.stringify(currentCanonical.models) !== JSON.stringify(nextCanonical.models)) {
    diffs.push(`models ${JSON.stringify(currentCanonical.models)} vs ${JSON.stringify(nextCanonical.models)}`);
  }

  throw new Error(`Account conflict for "${accountRef}": ${diffs.join('; ')}`);
}
