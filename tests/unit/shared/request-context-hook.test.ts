import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRequestId,
  currentRequestId,
  registerRequestContext,
} from '../../../src/shared/request-context.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createApp() {
  const app = Fastify({ logger: false, genReqId: createRequestId });
  apps.push(app);
  registerRequestContext(app);
  app.get('/probe', async (request) => ({ requestId: request.id, contextId: currentRequestId() }));
  return app;
}

describe('request context hook', () => {
  it('devolve e propaga um X-Request-ID valido recebido', async () => {
    const response = await createApp().inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': 'checkout-stage11' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('checkout-stage11');
    expect(response.json()).toEqual({ requestId: 'checkout-stage11', contextId: 'checkout-stage11' });
  });

  it('substitui header malformado por UUID seguro', async () => {
    const response = await createApp().inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-request-id': '<script>alert(1)</script>' },
    });
    const requestId = response.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json()).toEqual({ requestId, contextId: requestId });
  });
});
