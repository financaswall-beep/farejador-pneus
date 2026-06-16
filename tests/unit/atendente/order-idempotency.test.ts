import { describe, expect, it } from 'vitest';
import {
  buildOrderIdempotencyKey,
  type OrderFingerprintItem,
} from '../../../src/atendente-v2/order-idempotency.js';

const ITENS: OrderFingerprintItem[] = [{ product_id: 'p1', quantidade: 1, preco_unitario: 99 }];

describe('buildOrderIdempotencyKey', () => {
  it('é determinística: a MESMA chamada gera a MESMA chave (o bug do PED-0045/0046)', () => {
    const a = buildOrderIdempotencyKey('conv-1', 'unit-1', ITENS, 'delivery');
    const b = buildOrderIdempotencyKey('conv-1', 'unit-1', ITENS, 'delivery');
    expect(a).toBe(b);
  });

  it('nunca é nula e segue o formato bot:order:<conversa>:<hash16>', () => {
    const k = buildOrderIdempotencyKey('conv-1', 'unit-1', ITENS, 'delivery');
    expect(k).toMatch(/^bot:order:conv-1:[0-9a-f]{16}$/);
  });

  it('golden: trava o formato exato (regressão de refatoração)', () => {
    expect(buildOrderIdempotencyKey('conv-1', 'unit-1', ITENS, 'delivery')).toBe(
      'bot:order:conv-1:77e967a1ae8deee0',
    );
  });

  it('a matriz (unitId resolvido) gera chave estável e não-nula — fim do NULL que duplicava', () => {
    const matriz = buildOrderIdempotencyKey('conv-9', 'unit-matriz', ITENS, 'delivery');
    expect(matriz).toMatch(/^bot:order:conv-9:[0-9a-f]{16}$/);
    // determinística mesmo no caminho matriz
    expect(matriz).toBe(buildOrderIdempotencyKey('conv-9', 'unit-matriz', ITENS, 'delivery'));
  });

  it('unitId nulo (defensivo) ainda produz chave estável e não-nula', () => {
    const k = buildOrderIdempotencyKey('conv-2', null, ITENS, 'pickup');
    expect(k).toMatch(/^bot:order:conv-2:[0-9a-f]{16}$/);
  });

  it('muda a chave quando muda conversa, loja, modalidade ou itens (não dedup pedidos diferentes)', () => {
    const base = buildOrderIdempotencyKey('conv-1', 'unit-1', ITENS, 'delivery');
    expect(buildOrderIdempotencyKey('conv-2', 'unit-1', ITENS, 'delivery')).not.toBe(base); // conversa
    expect(buildOrderIdempotencyKey('conv-1', 'unit-2', ITENS, 'delivery')).not.toBe(base); // loja
    expect(buildOrderIdempotencyKey('conv-1', 'unit-1', ITENS, 'pickup')).not.toBe(base); // modalidade
    expect(
      buildOrderIdempotencyKey(
        'conv-1',
        'unit-1',
        [{ product_id: 'p2', quantidade: 1, preco_unitario: 99 }],
        'delivery',
      ),
    ).not.toBe(base); // item
    expect(
      buildOrderIdempotencyKey(
        'conv-1',
        'unit-1',
        [{ product_id: 'p1', quantidade: 2, preco_unitario: 99 }],
        'delivery',
      ),
    ).not.toBe(base); // quantidade
  });
});
