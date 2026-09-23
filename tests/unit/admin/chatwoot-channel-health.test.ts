import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { createChannelHealthReader } from '../../../src/admin/chatwoot-channel-health.js';
const config={baseUrl:'https://chatwoot.example.test/api/v1',accountId:2,apiToken:'secret-fixture-token'};
const inbox=(id:number,channel:string,required:unknown)=>({id,account_id:2,channel_type:channel,reauthorization_required:required});
const payload=(rows:unknown[])=>new Response(JSON.stringify({payload:rows}));
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe('autorização dos canais no Chatwoot',()=>{
  it('detecta Instagram e Facebook, sem devolver credenciais, contatos ou dados de outros canais/contas',async()=>{
    const fetcher=vi.fn().mockResolvedValue(payload([
      {...inbox(40,'Channel::Instagram',true),provider_config:{access_token:'do-not-return'},name:'private-name'},
      inbox(34,'Channel::FacebookPage',true),inbox(39,'Channel::Whatsapp',false),
      {...inbox(50,'Channel::Instagram',true),account_id:3},
    ]));
    const result=await createChannelHealthReader(config,fetcher)();
    expect(result.status).toBe('ok');expect(result.channels).toHaveLength(2);
    expect(result.channels.map(c=>c.channel)).toEqual(['instagram','facebook']);
    expect(result.channels.every(c=>c.authorization==='reauthorization_required')).toBe(true);
    expect(result.channels[0].reconnect_url).toBe('https://chatwoot.example.test/app/accounts/2/inbox/40');
    expect(JSON.stringify(result)).not.toMatch(/secret-fixture-token|do-not-return|private-name|provider_config/);
    expect(fetcher).toHaveBeenCalledWith('https://chatwoot.example.test/api/v1/accounts/2/inboxes',expect.objectContaining({
      headers:{api_access_token:config.apiToken},redirect:'error',signal:expect.any(AbortSignal),
    }));
  });
  it('não trata campo ausente, null ou string como autorização válida',async()=>{
    const fetcher=vi.fn().mockResolvedValue(payload([inbox(1,'Channel::Instagram',null),inbox(2,'Channel::FacebookPage','false'),
      inbox(3,'Channel::Instagram',false),inbox(4,'Channel::Instagram',undefined)]));
    const result=await createChannelHealthReader(config,fetcher)();
    expect(result.channels.map(c=>c.authorization)).toEqual(['unknown','unknown','no_reauthorization_required','unknown']);
  });
  it('compartilha consultas concorrentes e confirma a reconexão depois do cache',async()=>{
    const fetcher=vi.fn().mockImplementation(async()=>payload([inbox(40,'Channel::Instagram',fetcher.mock.calls.length===1)]));
    const read=createChannelHealthReader(config,fetcher);
    await Promise.all([read(),read(),read()]);await read();expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30001);
    expect((await read()).channels[0].authorization).toBe('no_reauthorization_required');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserva o último alerta sem fingir que a consulta recente funcionou',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(payload([inbox(40,'Channel::Instagram',true)]))
      .mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(payload([inbox(40,'Channel::Instagram',false)]));
    const read=createChannelHealthReader(config,fetcher),first=await read();await vi.advanceTimersByTimeAsync(30001);
    expect(await read()).toEqual({...first,status:'unavailable'});await read();expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15001);expect((await read()).status).toBe('ok');
  });
  it.each([401,403,429,500])('retorna estado indisponível no HTTP %s sem expor a resposta',async status=>{
    const fetcher=vi.fn().mockResolvedValue(new Response('secret-provider-error',{status}));
    expect(await createChannelHealthReader(config,fetcher)()).toEqual({status:'unavailable',checked_at:null,channels:[]});
  });
  it('distingue lista vazia de resposta inválida e configuração ausente',async()=>{
    expect((await createChannelHealthReader(config,vi.fn().mockResolvedValue(payload([])))()).status).toBe('ok');
    expect((await createChannelHealthReader(config,vi.fn().mockResolvedValue(new Response('{}')))()).status).toBe('unavailable');
    const fetcher=vi.fn();expect((await createChannelHealthReader(null,fetcher)()).status).toBe('not_configured');expect(fetcher).not.toHaveBeenCalled();
  });
  it('não mistura os caches de contas diferentes',async()=>{
    const fetcher=vi.fn().mockImplementation(async()=>payload([]));
    await createChannelHealthReader(config,fetcher)();await createChannelHealthReader({...config,accountId:3},fetcher)();
    expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1][0]).toContain('/accounts/3/inboxes');
  });
});
