import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let getAvatar: typeof import('../../../src/admin/painel/customer-lead-avatar.js').getCustomerLeadAvatar;
let safeAvatar: typeof import('../../../src/admin/painel/customer-lead-avatar.js').safeContactAvatar;
const config = { baseUrl:'https://chatwoot.example.test/api/v1',apiToken:'private-test-token' };
const ref = { contact_id:12,account_id:2 };
function poolFor(rows = [ref]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query,pool:{ query } as unknown as Pool };
}

beforeEach(async () => {
  vi.resetModules();
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgresql://test:test@example.test/test',
    CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin-token' });
  const module = await import('../../../src/admin/painel/customer-lead-avatar.js');
  getAvatar = module.getCustomerLeadAvatar; safeAvatar = module.safeContactAvatar;
});

describe('foto do lead pelo Chatwoot', () => {
  it('recupera foto já recebida no webhook mesmo com conta normalizada zero', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[{ contact_id:1003,account_id:0,conversation_id:731 }] })
      .mockResolvedValueOnce({ rows:[{ account_id:2,thumbnail:'https://chatwoot.example.test/known.png' }] });
    const fetcher = vi.fn();
    expect(await getAvatar('conversation','prod',{ query } as unknown as Pool,config,fetcher))
      .toBe('https://chatwoot.example.test/known.png');
    expect(fetcher).not.toHaveBeenCalled();
    const [sql,params] = query.mock.calls[1]!;
    expect(sql).toContain('environment=$1');
    expect(sql).toContain('account_id=$4');
    expect(params).toEqual(['prod',JSON.stringify({ conversation:{ id:731,meta:{ sender:{ id:1003 } } } }),
      JSON.stringify({ id:731,meta:{ sender:{ id:1003 } } }),0]);
  });
  it('não adivinha conta global quando falta referência comprovada no webhook', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[{ contact_id:1003,account_id:0,conversation_id:731 }] })
      .mockResolvedValueOnce({ rows:[] });
    const fetcher = vi.fn();
    expect(await getAvatar('conversation','prod',{ query } as unknown as Pool,config,fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('usa a conta comprovada para consultar a API quando o webhook não trouxe imagem', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[{ contact_id:1003,account_id:0,conversation_id:731 }] })
      .mockResolvedValueOnce({ rows:[{ account_id:2,thumbnail:null }] });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ payload:{ thumbnail:'https://chatwoot.example.test/fresh.png' } })));
    expect(await getAvatar('conversation','prod',{ query } as unknown as Pool,config,fetcher)).toContain('fresh.png');
    expect(fetcher.mock.calls[0][0]).toContain('/accounts/2/contacts/1003');
  });
  it('usa a conta da conversa, envia o token só ao Chatwoot e retorna apenas a foto', async () => {
    const { pool,query } = poolFor();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ payload:{
      name:'Nome não retornado',phone_number:'Telefone não retornado',thumbnail:'https://chatwoot.example.test/photo.png',
    } })));
    expect(await getAvatar('conversation','test',pool,config,fetcher)).toBe('https://chatwoot.example.test/photo.png');
    expect(query.mock.calls[0]?.[1]).toEqual(['conversation','test']);
    expect(String(query.mock.calls[0]?.[0])).toContain('c.environment=cv.environment');
    expect(fetcher).toHaveBeenCalledWith('https://chatwoot.example.test/api/v1/accounts/2/contacts/12',expect.objectContaining({
      headers:{ api_access_token:'private-test-token' },redirect:'error',
    }));
  });
  it('reaproveita foto por contato e ambiente sem misturar produção e teste', async () => {
    const { pool } = poolFor();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ payload:{ thumbnail:'https://chatwoot.example.test/a.png' } })));
    await Promise.all([getAvatar('a','test',pool,config,fetcher),getAvatar('b','test',pool,config,fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ payload:{ thumbnail:'https://chatwoot.example.test/prod.png' } })));
    expect(await getAvatar('a','prod',pool,config,fetcher)).toContain('prod.png');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('mantém fallback se não houver foto, configuração ou a API falhar', async () => {
    const { pool } = poolFor();
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await getAvatar('a','test',pool,null,fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getAvatar('a','test',pool,config,fetcher)).toBeNull();
  });
  it('não consulta contato fora da seleção autorizada do banco', async () => {
    const { pool } = poolFor([]);
    const fetcher = vi.fn();
    await expect(getAvatar('a','prod',pool,config,fetcher)).rejects.toThrow('lead_conversation_not_found');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('aceita HTTPS e caminho relativo, rejeita esquemas ativos e credenciais', () => {
    expect(safeAvatar('/rails/avatar.png','https://chatwoot.example.test/api/v1')).toBe('https://chatwoot.example.test/rails/avatar.png');
    for (const value of ['',null,'javascript:alert(1)','data:image/svg+xml,a','http://example.test/a','https://user:secret@example.test/a']) {
      expect(safeAvatar(value,config.baseUrl)).toBeNull();
    }
  });
});
