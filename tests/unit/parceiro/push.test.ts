/**
 * PUSH (PWA, 0109) — disparador de notificação nativa.
 * Cobre a lógica determinística e pura: que evento vira push (foto/pedido sim;
 * chat e desconhecido não) e o gate de configuração (flag + chaves VAPID). O
 * envio em si (web-push + banco) é I/O e fica de fora — aqui prova a DECISÃO.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };

async function loadPush(envOverrides: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('../../../src/shared/config/env.js', () => ({
    env: {
      FAREJADOR_ENV: 'test',
      PUSH_NOTIFICATIONS: false,
      VAPID_PUBLIC_KEY: undefined,
      VAPID_PRIVATE_KEY: undefined,
      VAPID_SUBJECT: 'mailto:test@test',
      ...envOverrides,
    },
  }));
  vi.doMock('../../../src/shared/logger.js', () => ({ logger: loggerMock }));
  vi.doMock('../../../src/persistence/db.js', () => ({ pool: { query: vi.fn() } }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));
  vi.doMock('../../../src/normalization/partner-chat.notify.js', () => ({
    subscribeAllPartnerChat: vi.fn(() => () => undefined),
  }));
  return import('../../../src/parceiro/push.js');
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('push — payloadForEvent (que evento vira aviso)', () => {
  it('foto → card de foto (tag foto)', async () => {
    const { payloadForEvent } = await loadPush({});
    const p = payloadForEvent({ unit_id: 'u1', conversation_id: '', kind: 'photo_request' });
    expect(p).not.toBeNull();
    expect(p?.tag).toBe('foto');
    expect(p?.title.toLowerCase()).toContain('foto');
  });

  it('pedido novo → card de pedido (tag pedido)', async () => {
    const { payloadForEvent } = await loadPush({});
    const p = payloadForEvent({ unit_id: 'u1', conversation_id: '', kind: 'new_order' });
    expect(p).not.toBeNull();
    expect(p?.tag).toBe('pedido');
    expect(p?.title.toLowerCase()).toContain('pedido');
  });

  it('mensagem de chat NÃO vira push', async () => {
    const { payloadForEvent } = await loadPush({});
    expect(payloadForEvent({ unit_id: 'u1', conversation_id: '7', kind: 'message' })).toBeNull();
  });

  it('kind desconhecido NÃO vira push', async () => {
    const { payloadForEvent } = await loadPush({});
    expect(payloadForEvent({ unit_id: 'u1', conversation_id: '', kind: 'whatever' })).toBeNull();
  });
});

describe('push — isPushConfigured (gate flag + chaves)', () => {
  it('flag on + as duas chaves = pronto', async () => {
    const { isPushConfigured } = await loadPush({
      PUSH_NOTIFICATIONS: true,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
    });
    expect(isPushConfigured()).toBe(true);
  });

  it('flag off = não pronto (mesmo com chaves)', async () => {
    const { isPushConfigured } = await loadPush({
      PUSH_NOTIFICATIONS: false,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
    });
    expect(isPushConfigured()).toBe(false);
  });

  it('sem chave privada = não pronto', async () => {
    const { isPushConfigured } = await loadPush({
      PUSH_NOTIFICATIONS: true,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: undefined,
    });
    expect(isPushConfigured()).toBe(false);
  });
});
