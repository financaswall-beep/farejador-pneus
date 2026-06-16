import { describe, expect, it } from 'vitest';
import {
  botAskedForLocation,
  buildLocationReplyNudge,
  LOCATION_REPLY_NUDGE,
} from '../../../src/atendente-v2/location-nudge.js';

describe('botAskedForLocation', () => {
  it('reconhece os pedidos de localização reais do prompt', () => {
    expect(botAskedForLocation('Pra eu te atender melhor, me manda a sua localização 📍 — ou me passa a rua, número e o bairro.')).toBe(true);
    expect(botAskedForLocation('Me manda tua localização 📍 ou tua rua, número e bairro que eu confiro na loja mais perto.')).toBe(true);
    expect(botAskedForLocation('Essa medida sai R$ 99,00. Me manda tua localização 📍 (ou tua rua, número e bairro).')).toBe(true);
  });

  it('NÃO dispara em falas que não pedem a localização (evita empurrão à toa)', () => {
    expect(botAskedForLocation('Show, Wallace. Sendo CG 160 Fan, o jogo certo é: Dianteiro 80/100-18 — R$ 99,00. Esse serve?')).toBe(false);
    expect(botAskedForLocation('Salve, Wallace! Beleza? Me fala qual pneu tu procura.')).toBe(false);
    expect(botAskedForLocation('Tá fechado! Pedido PED-0046, total R$ 207,90.')).toBe(false);
    expect(botAskedForLocation(null)).toBe(false);
    expect(botAskedForLocation('')).toBe(false);
  });

  it('NÃO confunde ENVIAR a localização da loja (retirada) com PEDIR a do cliente', () => {
    expect(botAskedForLocation('Boa! Te passo a localização da loja e o mapa pra retirada.')).toBe(false);
  });
});

describe('buildLocationReplyNudge', () => {
  it('anexa o empurrão quando o bot pediu localização e NÃO há pino', () => {
    expect(buildLocationReplyNudge('me manda tua localização 📍', false)).toBe(LOCATION_REPLY_NUDGE);
  });

  it('NÃO anexa quando há pino (o pino já tem o próprio nudge)', () => {
    expect(buildLocationReplyNudge('me manda tua localização 📍', true)).toBe('');
  });

  it('NÃO anexa quando a última fala do bot não pediu localização (prompt fica byte a byte → caching)', () => {
    expect(buildLocationReplyNudge('Esse serve?', false)).toBe('');
  });

  it('o texto do empurrão é PERMISSIVO: manda seguir o cliente se ele mudou de assunto (não engessa)', () => {
    expect(LOCATION_REPLY_NUDGE).toMatch(/mudou de assunto/i);
    expect(LOCATION_REPLY_NUDGE).toMatch(/NÃO é um roteiro fixo/i);
    // e ataca a regressão observada: não repetir o pneu já cotado
    expect(LOCATION_REPLY_NUDGE).toMatch(/não repita a medida/i);
  });
});
