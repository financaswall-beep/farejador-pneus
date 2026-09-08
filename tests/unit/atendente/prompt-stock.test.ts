import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../../../src/atendente-v2/prompt.js';

describe('prompt de estoque por produto', () => {
  it('proíbe quantidade solta quando existem várias opções', () => {
    expect(SYSTEM_PROMPT).toContain('attach each stock count to that SAME product name/brand and price');
    expect(SYSTEM_PROMPT).toContain('NEVER put a loose phrase such as "só resta 1" after the list');
    expect(SYSTEM_PROMPT).toContain('If only Maggion has 1');
  });
});
