import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { HubMemberOverviewCard } from '@/components/HubMemberOverviewCard';

describe('HubMemberOverviewCard', () => {
  it('renders trae builtin accounts as client-auth instead of API key', () => {
    const cat = {
      id: 'runtime-trae',
      displayName: '运行时 Trae 猫',
      nickname: '慢慢',
      provider: 'trae',
      defaultModel: 'GLM-5',
      color: { primary: '#0f172a', secondary: '#e2e8f0' },
      mentionPatterns: ['@runtime-trae'],
      avatar: '/avatars/trae.png',
      roleDescription: '审查',
      source: 'runtime',
      accountRef: 'trae',
    } as CatData;

    const html = renderToStaticMarkup(<HubMemberOverviewCard cat={cat} />);
    expect(html).toContain('Trae');
    expect(html).toContain('内置 client-auth 账号');
    expect(html).not.toContain('API Key · trae');
  });
});
