/**
 * Ticket do "escolhe a loja" — porta única (0095).
 * Garante: uso único, expiração de 2 min, formato, e que o conteúdo devolvido
 * carrega exatamente o que a rota /api/login/escolher precisa (sem expiresAt).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetLoginTickets, consumeLoginTicket, newLoginTicket } from '../../../src/parceiro/login-ticket.js';

const STORES = [
  { token_id: 'tok-a', slug: 'loja-a', store_name: 'Loja A', role: 'owner' },
  { token_id: 'tok-b', slug: 'loja-b', store_name: 'Loja B', role: 'funcionario' },
];

describe('login-ticket (porta única)', () => {
  beforeEach(() => {
    __resetLoginTickets();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emite com prefixo lt_ e 64 hex', () => {
    const ticket = newLoginTicket('test', 'person-1', STORES);
    expect(ticket).toMatch(/^lt_[a-f0-9]{64}$/);
  });

  it('consome devolvendo environment, personId e as lojas', () => {
    const ticket = newLoginTicket('test', 'person-1', STORES);
    const data = consumeLoginTicket(ticket);
    expect(data).not.toBeNull();
    expect(data!.environment).toBe('test');
    expect(data!.personId).toBe('person-1');
    expect(data!.stores).toHaveLength(2);
    expect(data!.stores[0]!.token_id).toBe('tok-a');
    expect(data).not.toHaveProperty('expiresAt');
  });

  it('é USO ÚNICO: o segundo consumo devolve null', () => {
    const ticket = newLoginTicket('test', 'person-1', STORES);
    expect(consumeLoginTicket(ticket)).not.toBeNull();
    expect(consumeLoginTicket(ticket)).toBeNull();
  });

  it('expira em 2 minutos', () => {
    const ticket = newLoginTicket('test', 'person-1', STORES);
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);
    expect(consumeLoginTicket(ticket)).toBeNull();
  });

  it('dentro da janela ainda vale', () => {
    const ticket = newLoginTicket('test', 'person-1', STORES);
    vi.advanceTimersByTime(2 * 60 * 1000 - 1000);
    expect(consumeLoginTicket(ticket)).not.toBeNull();
  });

  it('ticket inventado, malformado ou sem prefixo devolve null', () => {
    expect(consumeLoginTicket('lt_' + 'a'.repeat(64))).toBeNull();
    expect(consumeLoginTicket('qualquer-coisa')).toBeNull();
    expect(consumeLoginTicket('')).toBeNull();
  });

  it('tickets são independentes (consumir um não mata o outro)', () => {
    const t1 = newLoginTicket('test', 'person-1', STORES);
    const t2 = newLoginTicket('test', 'person-2', STORES.slice(0, 1));
    expect(consumeLoginTicket(t1)).not.toBeNull();
    const d2 = consumeLoginTicket(t2);
    expect(d2).not.toBeNull();
    expect(d2!.personId).toBe('person-2');
  });
});
