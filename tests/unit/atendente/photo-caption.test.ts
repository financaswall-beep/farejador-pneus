import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), enqueuePhotoAttachment: vi.fn(), env: { BOT_OUTBOX: true },
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: mocks.env }));
vi.mock('../../../src/atendente-v2/outbox-accessory.js', () => ({
  enqueueAccessoryText: vi.fn(), enqueuePhotoAttachment: mocks.enqueuePhotoAttachment,
}));

import { dispatchPhotoToCustomer } from '../../../src/atendente-v2/photo-requests.js';

describe('legenda da foto sem anúncio automático da marca', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.env.BOT_OUTBOX = true; });

  it.each([false, true])('preserva destino e foto solicitada, inclusive com atraso=%s', async wasLate => {
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{
      // Pedidos de foto já existentes podem ter o nome comercial no tire_size.
      environment: 'test', conversation_id: '123', tire_size: 'Pneu Pirelli 90/90-12', brand: 'Pirelli', status: 'pending',
    }] });
    await dispatchPhotoToCustomer('foto-escolhida', { bytes: Buffer.from('photo'), mime: 'image/jpeg' }, wasLate);
    expect(mocks.enqueuePhotoAttachment).toHaveBeenCalledOnce();
    const sent = mocks.enqueuePhotoAttachment.mock.calls[0]![1];
    expect(sent).toMatchObject({ environment: 'test', chatwootConversationId: 123, photoRequestId: 'foto-escolhida' });
    expect(sent.caption).toContain('estado');
    expect(sent.caption).not.toContain('Pirelli');
  });

  it.each(['cancelled', 'outbox-off'])('preserva o bloqueio de envio: %s', reason => {
    mocks.env.BOT_OUTBOX = reason !== 'outbox-off';
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{
      environment: 'test', conversation_id: '123', tire_size: '90/90-12', status: reason === 'cancelled' ? 'cancelled' : 'pending',
    }] });
    return dispatchPhotoToCustomer('foto', { bytes: Buffer.from('photo'), mime: 'image/jpeg' }, false)
      .then(() => expect(mocks.enqueuePhotoAttachment).not.toHaveBeenCalled());
  });
});
