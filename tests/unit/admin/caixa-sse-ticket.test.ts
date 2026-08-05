import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCaixaSseTickets,
  consumeCaixaSseTicket,
  mintCaixaSseTicket,
} from '../../../src/admin/caixa/sse-ticket.js';

const context = { unitId: 'main-unit', subject: 'caixa:person-1' };

describe('ticket SSE de fotos do caixa', () => {
  beforeEach(() => __resetCaixaSseTickets());
  afterEach(() => vi.useRealTimers());

  it('é opaco, curto e de uso único', () => {
    const issued = mintCaixaSseTicket(context);

    expect(issued.ticket).toMatch(/^ct_[a-f0-9]{64}$/);
    expect(issued.expiresInSeconds).toBe(60);
    expect(consumeCaixaSseTicket(issued.ticket)).toEqual(context);
    expect(consumeCaixaSseTicket(issued.ticket)).toBeNull();
  });

  it('rejeita ticket inválido ou expirado', () => {
    expect(consumeCaixaSseTicket('Bearer segredo')).toBeNull();
    vi.useFakeTimers();
    const { ticket } = mintCaixaSseTicket(context);
    vi.advanceTimersByTime(60_001);
    expect(consumeCaixaSseTicket(ticket)).toBeNull();
  });
});
