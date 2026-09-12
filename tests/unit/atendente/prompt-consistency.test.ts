import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  PHOTO_REQUESTS: false,
  DELIVERY_FREIGHT_FROM_PIN: true,
  FAREJADOR_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  PARTNER_DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  DATABASE_SSL: false,
}));

vi.mock('../../../src/shared/config/env.js', () => ({ env: config }));

import { SYSTEM_PROMPT, PHOTO_PROMPT_BLOCK } from '../../../src/atendente-v2/prompt.js';
import { activeToolDefinitions } from '../../../src/atendente-v2/tools.js';

describe('consistência das regras centrais do prompt', () => {
  it('usa a mesma regra de oferta nas buscas por medida e por moto', () => {
    for (const name of ['buscar_produto', 'buscar_compatibilidade']) {
      const definition = activeToolDefinitions().find(tool => tool.function.name === name);
      expect(definition?.function.description).toContain('SINGLE TIRE OFFER');
    }
  });

  it('separa pergunta institucional de retirada com produto', () => {
    expect(SYSTEM_PROMPT).toContain('A general institutional question such as "onde fica a matriz?"');
    expect(SYSTEM_PROMPT).toContain('PICKUP OF A CHOSEN TIRE');
    expect(SYSTEM_PROMPT).toContain('NEVER reveal that pickup store\'s street address or Maps link before the order is CREATED');
    expect(SYSTEM_PROMPT).not.toContain('then send the store NAME, the written ADDRESS');
  });

  it('define pagamento no recebimento para entrega e retirada', () => {
    expect(SYSTEM_PROMPT).toContain('PAYMENT: ALWAYS ON RECEIPT, NEVER IN ADVANCE');
    expect(SYSTEM_PROMPT).toContain('"[forma] na entrega"');
    expect(SYSTEM_PROMPT).toContain('"[forma] na retirada"');
    expect(SYSTEM_PROMPT).not.toContain('PAYMENT: ALWAYS on delivery');
  });

  it('avança após aceite implícito e não pede confirmação duplicada', () => {
    expect(SYSTEM_PROMPT).toContain('Do NOT ask for acceptance again');
    expect(SYSTEM_PROMPT).toContain('Você: Show. É pra entregar no teu endereço ou retirar na loja?');
    expect(SYSTEM_PROMPT).not.toContain('Você: Show, [nome]. Bora fechar?');
  });

  it('monta o resumo pelos itens reais e aceita posição desconhecida', () => {
    expect(SYSTEM_PROMPT).toContain('exactly one summary line per ordered item');
    expect(SYSTEM_PROMPT).toContain('when position is unregistered/unknown, use "*Item:*"');
    expect(SYSTEM_PROMPT).not.toContain('✅ *Traseiro:* Pneu [size]\n✅ *Total:*');
  });

  it('descreve localizacao_loja de acordo com o retorno real', () => {
    const definition = activeToolDefinitions().find((tool) => tool.function.name === 'localizacao_loja');
    expect(definition?.function.description).toContain('nunca endereço nem link do mapa');
    expect(definition?.function.description).toContain('se o cliente já enviou um pino, chame sem bairro');
    expect(definition?.function.description).toContain('Endereço e mapa da retirada só vêm de criar_pedido');
    expect(definition?.function.description).not.toContain('Retorna nome, endereço escrito');
  });

  it('remove a orientação de preencher a espera da foto com outra oferta', () => {
    config.PHOTO_REQUESTS = true;
    try {
      const photo = activeToolDefinitions().find(tool => tool.function.name === 'pedir_foto');
      expect(photo?.function.description).toContain('Preserve a escolha seguindo PURCHASE CONTINUITY');
      expect(photo?.function.description).not.toContain('SIGA a conversa normalmente');
      expect(photo?.function.description).not.toContain('1 minutinho');
      expect(PHOTO_PROMPT_BLOCK).not.toContain('do NOT wait');
      expect(PHOTO_PROMPT_BLOCK).toContain('use prazo_min');
      expect(PHOTO_PROMPT_BLOCK).toContain('This reply may end there');
    } finally { config.PHOTO_REQUESTS = false; }
  });

  it('distingue gostar do pneu de aceitar a retirada e mantém a mudança de escolha autorizada', () => {
    expect(SYSTEM_PROMPT).toContain('"gostei"/"goste1" approves interest in the tire, not the trip');
    expect(SYSTEM_PROMPT).toContain('If the customer asks for another option, search normally');
    expect(SYSTEM_PROMPT).toContain('After pickup is confirmed, advance to only missing closing details');
    expect(SYSTEM_PROMPT).not.toContain('Rotate between:');
  });
});
