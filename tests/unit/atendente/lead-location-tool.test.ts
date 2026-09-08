import { describe, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({
  PHOTO_REQUESTS:false,DELIVERY_FREIGHT_FROM_PIN:false,FAREJADOR_ENV:'test',
  DATABASE_URL:'postgresql://test:test@localhost:5432/test',
  PARTNER_DATABASE_URL:'postgresql://test:test@localhost:5432/test',DATABASE_SSL:false,
}));
vi.mock('../../../src/shared/config/env.js', () => ({ env:config }));
import { activeToolDefinitions, executeTool } from '../../../src/atendente-v2/tools.js';
import { SYSTEM_PROMPT } from '../../../src/atendente-v2/prompt.js';

describe('memória da localização digitada pelo lead', () => {
  it('expõe ferramenta silenciosa e orienta registro sem confirmar entrega', () => {
    const definition = activeToolDefinitions().find(tool => tool.function.name === 'registrar_localizacao_lead');
    expect(definition?.function.parameters).toMatchObject({
      required: ['texto_informado', 'tipo'],
      additionalProperties: false,
    });
    expect(SYSTEM_PROMPT).toContain('call registrar_localizacao_lead ONCE');
    expect(SYSTEM_PROMPT).toContain('ESTIMATED LEAD LOCATION, never a confirmed delivery address');
  });

  it('valida o mínimo sem escrever diretamente no banco', async () => {
    const db = { query: async () => { throw new Error('não deveria consultar banco'); } } as any;
    expect(JSON.parse(await executeTool(db, 'test', 'conv', 'registrar_localizacao_lead', {
      texto_informado: 'Rua 43, Itaipuaçu, Maricá', tipo: 'endereco_digitado',
      rua: 'Rua 43', municipio: 'Maricá',
    }))).toMatchObject({ ok: true, registrado: 'localizacao_lead' });
    expect(JSON.parse(await executeTool(db, 'test', 'conv', 'registrar_localizacao_lead', {
      texto_informado: '   ', tipo: 'regiao_digitada',
    }))).toEqual({ erro: 'localizacao_lead_invalida' });
  });
});
