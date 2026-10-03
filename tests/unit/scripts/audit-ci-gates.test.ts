import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { contratoDeAcesso } from '../../../scripts/prova-rotas-matriz.js';
const require = createRequire(import.meta.url);
const { compararManifestos } = require('../../../scripts/prova-paridade-matriz.cjs');

describe('fiscais da auditoria continuam recusando regressões', () => {
  const requireAdminAuth = async () => undefined;
  const requireAdminOwner = async () => undefined;
  const flagGate = async () => undefined;
  const route = (guards: unknown[], url = '/admin/api/matriz/financeiro') => ({
    url, method: 'GET', preHandler: guards,
  }) as never;
  it('aceita guarda de autenticação seguido de disponibilidade', () => {
    expect(contratoDeAcesso(route([requireAdminAuth, flagGate]))).toContain('ROLE(owner|admin)');
    expect(contratoDeAcesso(route([requireAdminOwner, flagGate]))).toContain('ROLE(owner)');
  });
  it('recusa API sem autenticação, autenticação fora de ordem ou em duplicidade', () => {
    for (const guards of [[], [flagGate], [flagGate, requireAdminAuth], [requireAdminAuth, requireAdminOwner]]) {
      expect(() => contratoDeAcesso(route(guards))).toThrow('exatamente um guarda');
    }
  });
  it('recusa API nova sem mapeamento de módulo mesmo se exigir dono', () => {
    expect(() => contratoDeAcesso(route([requireAdminOwner], '/admin/api/sem-mapeamento'))).toThrow('sem módulo');
  });
  it('detecta método removido, adicionado e getter convertido em valor', () => {
    expect(compararManifestos({ vender:'function', saldo:'getter' }, { saldo:'value:number', novo:'function' }))
      .toEqual({sumiram:['vender'],surgiram:['novo'],mudaram:['saldo']});
    expect(compararManifestos({vender:'function'}, {vender:'function'}))
      .toEqual({sumiram:[],surgiram:[],mudaram:[]});
  });
});
