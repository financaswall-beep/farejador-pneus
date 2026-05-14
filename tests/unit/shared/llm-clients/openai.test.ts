import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOpenAI } from '../../../../src/shared/llm-clients/openai.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('callOpenAI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omite temperature quando a opcao nao foi definida', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'retorne json' }],
      timeoutMs: 1000,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.temperature).toBeUndefined();
  });

  it('envia temperature quando a opcao foi definida', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      apiKey: 'sk-test',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'retorne json' }],
      timeoutMs: 1000,
      temperature: 0.2,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.temperature).toBe(0.2);
  });
});
