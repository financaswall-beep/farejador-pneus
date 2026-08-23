import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPanelLoginTickets,
  consumePanelLoginTicket,
  newPanelLoginTicket,
} from '../../../src/admin/panel-login-ticket.js';

const workplace = {
  id: 'partner:rio-do-ouro', kind: 'partner' as const, name: 'Rio do Ouro',
  role: 'owner', slug: 'rio-do-ouro', tokenId: 'internal-token-id', displayName: 'Dono',
  modules: { vendas: true, estoque: true, entregas: true, financeiro: true },
};

describe('ticket do broker do painel', () => {
  beforeEach(() => __resetPanelLoginTickets());

  it('é opaco, expira por uso e mantém IDs internos somente no servidor', () => {
    const ticket = newPanelLoginTicket('test', 'person-1', 'dono', [workplace]);
    expect(ticket).toMatch(/^pt_[a-f0-9]{64}$/);

    const first = consumePanelLoginTicket(ticket);
    expect(first).toMatchObject({ environment: 'test', personId: 'person-1' });
    expect(first?.workplaces[0]).toMatchObject({ tokenId: 'internal-token-id' });
    expect(consumePanelLoginTicket(ticket)).toBeNull();
  });

  it('não aceita prefixos de tickets dos outros portais', () => {
    expect(consumePanelLoginTicket(`ot_${'a'.repeat(64)}`)).toBeNull();
    expect(consumePanelLoginTicket(`lt_${'a'.repeat(64)}`)).toBeNull();
  });
});
