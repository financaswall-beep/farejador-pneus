import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOperationLoginTickets,
  consumeOperationLoginTicket,
  newOperationLoginTicket,
} from '../../../src/admin/caixa/operation-login-ticket.js';
import type { OperationWorkplace } from '../../../src/admin/caixa/operation-auth.js';

const WORKPLACES: OperationWorkplace[] = [
  {
    id: 'matrix', kind: 'matrix', name: 'Matriz', role: 'vendedor', collaboratorId: 'collab-1',
    modules: { vendas: true, estoque: false, entregas: false, retiradas: false, financeiro: false },
  },
  {
    id: 'partner:rio-do-ouro',
    kind: 'partner',
    name: 'Borracharia Rio do Ouro',
    role: 'funcionario',
    slug: 'rio-do-ouro',
    tokenId: 'token-1',
    displayName: 'Wallace',
    modules: { vendas: true, estoque: true, entregas: true, retiradas: true, financeiro: false },
  },
];

describe('ticket de escolha da Operação da Loja', () => {
  beforeEach(() => {
    __resetOperationLoginTickets();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('é opaco, de uso único e guarda os vínculos somente no servidor', () => {
    const ticket = newOperationLoginTicket('test', 'person-1', 'wallace', WORKPLACES);
    expect(ticket).toMatch(/^ot_[a-f0-9]{64}$/);

    const data = consumeOperationLoginTicket(ticket);
    expect(data).toMatchObject({ environment: 'test', personId: 'person-1', username: 'wallace' });
    expect(data?.workplaces).toEqual(WORKPLACES);
    expect(data).not.toHaveProperty('expiresAt');
    expect(consumeOperationLoginTicket(ticket)).toBeNull();
  });

  it('vence depois de dois minutos', () => {
    const ticket = newOperationLoginTicket('test', 'person-1', 'wallace', WORKPLACES);
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);
    expect(consumeOperationLoginTicket(ticket)).toBeNull();
  });
});
