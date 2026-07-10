import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';
import {
  __resetPartnerSseTickets,
  consumePartnerSseTicket,
  mintPartnerSseTicket,
} from '../../../src/parceiro/sse-ticket.js';

const context: PartnerContext = {
  environment: 'prod',
  partnerId: 'partner-1',
  partnerUnitId: 'partner-unit-1',
  unitId: 'unit-1',
  slug: 'loja-centro',
  partnerName: 'Parceiro',
  unitName: 'Centro',
  role: 'owner',
  tokenId: 'token-id-1',
};

describe('partner SSE ticket', () => {
  beforeEach(() => __resetPartnerSseTickets());
  afterEach(() => vi.useRealTimers());

  it('is opaque, short-lived and can be consumed only once', () => {
    const issued = mintPartnerSseTicket(context);

    expect(issued.ticket).toMatch(/^st_[a-f0-9]{64}$/);
    expect(issued.expiresInSeconds).toBe(60);
    expect(consumePartnerSseTicket(issued.ticket, context.slug)).toEqual(context);
    expect(consumePartnerSseTicket(issued.ticket, context.slug)).toBeNull();
  });

  it('consumes and rejects a ticket used for another slug', () => {
    const { ticket } = mintPartnerSseTicket(context);

    expect(consumePartnerSseTicket(ticket, 'outra-loja')).toBeNull();
    expect(consumePartnerSseTicket(ticket, context.slug)).toBeNull();
  });

  it('rejects an expired ticket', () => {
    vi.useFakeTimers();
    const { ticket } = mintPartnerSseTicket(context);
    vi.advanceTimersByTime(60_001);

    expect(consumePartnerSseTicket(ticket, context.slug)).toBeNull();
  });
});
