import type { AccountProtocol } from '@cat-cafe/shared';

export function buildProbeHeaders(protocol: AccountProtocol, apiKey: string): Record<string, string> {
  switch (protocol) {
    case 'anthropic':
      return {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
    case 'google':
      return {
        'x-goog-api-key': apiKey,
      };
    case 'openai':
    case 'openai-responses':
    default:
      return {
        Authorization: `Bearer ${apiKey}`,
      };
  }
}

export async function readProbeError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      const json = (await response.json()) as Record<string, unknown>;
      const nestedError = json.error;
      if (typeof nestedError === 'string') return nestedError;
      if (nestedError && typeof nestedError === 'object') {
        const message = (nestedError as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) return message;
      }
      const message = json.message;
      if (typeof message === 'string' && message.trim()) return message;
      return JSON.stringify(json);
    }
  } catch {
    // fall through to text read below
  }

  try {
    const text = await response.text();
    return text.trim() || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function isInvalidModelProbeError(message: string | null | undefined): boolean {
  const normalized = message?.toLowerCase() ?? '';
  return (
    normalized.includes('model') &&
    (normalized.includes('invalid') || normalized.includes('not found') || normalized.includes('unsupported'))
  );
}
