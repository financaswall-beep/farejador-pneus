import {expect,it,vi} from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',BOT_AUDIO_ALLOWED_HOSTS:['files.example.test'],CHATWOOT_API_BASE_URL:'https://chat.example.test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
import {fullSources,listFullSources} from '../../../src/admin/dot/full-catalog.js';
import {recordsInput} from '../../../src/admin/dot/full-records.js';
import {downloadDotAttachment} from '../../../src/admin/dot/attachment-download.js';
import {reportSnapshotPool} from '../../../src/admin/dot/report-snapshot.js';

it('catálogo publica PII autorizada, mas jamais tabelas de autenticação ou campos secretos',()=>{
  expect(fullSources.length).toBeGreaterThan(190);
  for(const source of fullSources) {
    expect(source.key).not.toMatch(/oauth|sessions|raw\.|push_subscriptions/);
    expect(source.fields.join(' ')).not.toMatch(/password|token_hash|reading_token|storage_path|original_path|client_token|raw_payload/);
    expect(source.scalar.every(f=>source.fields.includes(f))).toBe(true);
  }
  expect(listFullSources({fonte:'commerce.customers'})).toMatchObject({campos:expect.arrayContaining(['name','phone_e164','email','notes'])});
  expect(listFullSources({fonte:'finance.matriz_payroll_items'})).toMatchObject({campos:expect.arrayContaining(['base_salary','total_due'])});
  expect(listFullSources({fonte:'finance.partner_expenses'})).toMatchObject({campos:expect.arrayContaining(['description','amount'])});
});
it('campos com números funcionam e entradas SQL/ambiente externo não são aceitas',()=>{
  expect(recordsInput.parse({fonte:'commerce.customers',campos:['phone_e164']})).toMatchObject({campos:['phone_e164']});
  for(const input of [{campos:['id);delete from commerce.orders;--']},{environment:'prod'},{sql:'select *'},{campo_data:'created_at',de:'2026-02-30'}]) {
    expect(recordsInput.safeParse({fonte:'commerce.customers',...input}).success).toBe(false);
  }
});
it('adapter de relatório usa somente o cliente protegido e nunca finaliza sua transação',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{ok:true}]}),db=reportSnapshotPool({query} as never),client=await db.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query('COMMIT');
  expect(query).not.toHaveBeenCalled();
  await client.query('SELECT 1',[]);expect(query).toHaveBeenCalledWith('SELECT 1',[]);
  query.mockRejectedValueOnce(Error('cannot execute UPDATE in a read-only transaction'));
  await expect(client.query('UPDATE commerce.orders SET status=\'cancelled\'')).rejects.toThrow('read-only');
});
it('download não aceita URLs externas, credenciais ou hosts locais e revalida cada redirecionamento',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}}));
  for(const url of ['http://files.example.test/a','https://127.0.0.1/a','https://user:password@files.example.test/a','https://evil.example/a']) {
    await expect(downloadDotAttachment(url,fetcher)).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(await downloadDotAttachment('https://files.example.test/a',fetcher)).toEqual(Buffer.from([1,2,3]));
  expect(fetcher).toHaveBeenCalledWith(expect.any(URL),expect.objectContaining({redirect:'manual'}));
  expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('headers');
  fetcher.mockResolvedValueOnce(new Response('x',{status:302,headers:{location:'http://localhost'}}));
  await expect(downloadDotAttachment('https://files.example.test/a',fetcher)).rejects.toThrow('audio_host_not_allowed');
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockReset().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://files.example.test/real.jpg'}}))
    .mockResolvedValueOnce(new Response(new Uint8Array([4,5])));
  expect(await downloadDotAttachment('https://chat.example.test/file',fetcher)).toEqual(Buffer.from([4,5]));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1].signal).toBe(fetcher.mock.calls[1]![1].signal);
  fetcher.mockReset().mockImplementation(()=>Promise.resolve(new Response(null,{status:302,headers:{location:'/loop'}})));
  await expect(downloadDotAttachment('https://files.example.test/a',fetcher)).rejects.toThrow('attachment_unavailable');
  expect(fetcher).toHaveBeenCalledTimes(4);
});
