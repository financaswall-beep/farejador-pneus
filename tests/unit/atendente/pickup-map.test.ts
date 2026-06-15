import { describe, expect, it } from 'vitest';
import {
  ensurePickupMap,
  extractPickupCardFromActions,
  type PickupCard,
} from '../../../src/atendente-v2/pickup-map.js';

const MAPS = 'https://www.google.com/maps/search/?api=1&query=-22.9035,-43.2096';

function actionsWith(resultJson: string, toolName = 'criar_pedido') {
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: toolName } }] },
    { role: 'tool', tool_call_id: 'call_1', content: resultJson },
  ];
}

describe('extractPickupCardFromActions', () => {
  it('lê o cartão da retirada do resultado do criar_pedido', () => {
    const json = JSON.stringify({
      ok: true,
      order_number: 'PED-0044',
      total: '99.00',
      retirada: { nome_loja: 'Borracharia Méier', endereco: 'Rua X, 10', maps_url: MAPS, horario: '08-18' },
    });
    expect(extractPickupCardFromActions(actionsWith(json))).toEqual({
      nome_loja: 'Borracharia Méier',
      endereco: 'Rua X, 10',
      maps_url: MAPS,
    });
  });

  it('entrega (sem retirada no resultado) => null', () => {
    const json = JSON.stringify({ ok: true, order_number: 'PED-0044', total: '108.90' });
    expect(extractPickupCardFromActions(actionsWith(json))).toBeNull();
  });

  it('sem criar_pedido nos actions => null', () => {
    expect(extractPickupCardFromActions(actionsWith(JSON.stringify({ encontrado: true }), 'buscar_produto'))).toBeNull();
  });

  it('retirada com maps_url null (loja sem mapa) => cartão com maps_url null', () => {
    const json = JSON.stringify({ ok: true, retirada: { nome_loja: 'Loja Z', endereco: null, maps_url: null } });
    expect(extractPickupCardFromActions(actionsWith(json))).toEqual({ nome_loja: 'Loja Z', endereco: null, maps_url: null });
  });

  it('JSON malformado no resultado => null (fail-safe)', () => {
    expect(extractPickupCardFromActions(actionsWith('{nao eh json'))).toBeNull();
  });

  it('tool result com id diferente do criar_pedido => null', () => {
    const actions = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_9', function: { name: 'criar_pedido' } }] },
      { role: 'tool', tool_call_id: 'call_OUTRO', content: JSON.stringify({ retirada: { nome_loja: 'X', maps_url: MAPS } }) },
    ];
    expect(extractPickupCardFromActions(actions)).toBeNull();
  });

  it('pega o ÚLTIMO criar_pedido quando há retry no turno', () => {
    const actions = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'criar_pedido' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: false }) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', function: { name: 'criar_pedido' } }] },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ ok: true, retirada: { nome_loja: 'Loja Final', endereco: 'R. 2', maps_url: MAPS } }) },
    ];
    expect(extractPickupCardFromActions(actions)?.nome_loja).toBe('Loja Final');
  });
});

describe('ensurePickupMap', () => {
  const card: PickupCard = { nome_loja: 'Loja', endereco: 'Rua X, 10', maps_url: MAPS };

  it('anexa o link quando o resumo da retirada não tem o Maps', () => {
    const text = 'Tá fechado 👍\n\n✅ *Pedido:* PED-0044\n💳 *Pagamento:* _Pix na retirada_';
    const out = ensurePickupMap(text, card);
    expect(out.includes(MAPS)).toBe(true);
    expect(out.endsWith(MAPS)).toBe(true);
  });

  it('não duplica quando o link já está no resumo (idempotente)', () => {
    const text = `Resumo\n${MAPS}\n💳 *Pagamento:* _Pix na retirada_`;
    expect(ensurePickupMap(text, card)).toBe(text);
  });

  it('cartão null => texto intacto', () => {
    expect(ensurePickupMap('qualquer coisa', null)).toBe('qualquer coisa');
  });

  it('cartão sem maps_url => texto intacto (não inventa)', () => {
    expect(ensurePickupMap('resumo de retirada', { nome_loja: 'L', endereco: 'R', maps_url: null })).toBe('resumo de retirada');
  });
});
