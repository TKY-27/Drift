import { stripUnsafeText, safeSnippet } from '../utils/security.js';

export function renderJson(value: unknown): string {
  return `${JSON.stringify(sanitizeJson(value), null, 2)}\n`;
}

function sanitizeJson(value: unknown): unknown {
  if (typeof value === 'string') return safeSnippet(value, 1000);
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [stripUnsafeText(key), sanitizeJson(entry)]));
  }
  return value;
}
