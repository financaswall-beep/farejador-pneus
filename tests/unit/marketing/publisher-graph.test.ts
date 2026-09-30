import { beforeEach,describe,it,expect,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{}}));
import { PublisherGraph,type Delivery } from '../../../src/marketing/publisher/graph.js';
import { META_BUSINESS_ACCOUNTS as accounts } from '../../../src/shared/meta-business-accounts.js';
const config={enabled:true,publish:true,pageId:accounts.facebook.id,instagramId:accounts.instagram.id,token:'secret-page',apiVersion:'v26.0',scopeValid:true};
const fetcher=vi.fn<typeof fetch>();
const json=(body:unknown)=>new Response(JSON.stringify(body));
const task=(extra:Partial<Delivery>={}):Delivery=>({platform:'instagram',format:'reel',caption:'Pneus',account_id:accounts.instagram.id,container_id:'301',provider_id:'302',media_kind:'video',...extra});
beforeEach(()=>fetcher.mockReset());
describe('Publicação Meta nas contas fixadas',()=>{
  it('cria container IG sem publicar e utiliza token da Página',async()=>{
    fetcher.mockResolvedValueOnce(json({id:accounts.facebook.id,instagram_business_account:{id:accounts.instagram.id}})).mockResolvedValueOnce(json({id:'301'}));
    const graph=new PublisherGraph(config,fetcher);
    expect(await graph.prepare(task(),'https://project.supabase.co/signed')).toBe('301');
    const call=fetcher.mock.calls[1]!;expect(String(call[0])).toContain('/'+accounts.instagram.id+'/media');
    const body=new URLSearchParams(String(call[1]?.body));expect(body.get('media_type')).toBe('REELS');expect(body.get('video_url')).toContain('/signed');
    expect(call[1]?.headers).toMatchObject({Authorization:'Bearer secret-page'});
  });
  it('não envia legenda de Story como sobreposição nem aceita conta diferente',async()=>{
    const graph=new PublisherGraph(config,fetcher);
    await expect(graph.prepare(task({account_id:'999'}),'https://source.test')).rejects.toThrow('meta_account_not_allowed');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(json({id:accounts.facebook.id,instagram_business_account:{id:accounts.instagram.id}})).mockResolvedValueOnce(json({id:'301'}));
    await graph.prepare(task({format:'story',media_kind:'photo'}),'https://project.supabase.co/signed');
    const body=new URLSearchParams(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body.get('media_type')).toBe('STORIES');expect(body.has('caption')).toBe(false);expect(body.has('image_url')).toBe(true);
  });
  it('espera FINISHED e classifica timeout público como incerto',async()=>{
    const graph=new PublisherGraph(config,fetcher);
    fetcher.mockResolvedValueOnce(json({status_code:'IN_PROGRESS'})).mockResolvedValueOnce(json({status_code:'FINISHED'}));
    expect(await graph.ready(task())).toBe(false);expect(await graph.ready(task())).toBe(true);
    fetcher.mockRejectedValueOnce(Error('secret-page must not leak'));
    try{await graph.publish(task());throw Error('expected rejection');}catch(error:any){expect(error).toMatchObject({code:'meta_connection_unknown',uncertain:true});expect(error.message).not.toContain('secret-page');}
  });
  it('confirma publicação por leitura antes de considerar o envio concluído',async()=>{
    fetcher.mockResolvedValue(json({id:'302',timestamp:'2026-09-30T09:00:00+0000',permalink:'https://www.instagram.com/p/test/'}));
    expect(await new PublisherGraph(config,fetcher).verify(task())).toEqual({confirmed:true,url:'https://www.instagram.com/p/test/'});
  });
  it('usa endpoint de upload fixo e só conclui Reel FB quando publishing_phase termina',async()=>{
    const graph=new PublisherGraph(config,fetcher);const d=task({platform:'facebook',account_id:accounts.facebook.id});
    fetcher.mockResolvedValueOnce(json({id:accounts.facebook.id})).mockResolvedValueOnce(json({video_id:'301',upload_url:'https://evil.test'})).mockResolvedValueOnce(json({success:true}));
    await graph.prepare(d,'https://project.supabase.co/signed');expect(String(fetcher.mock.calls[2]?.[0])).toBe('https://rupload.facebook.com/video-upload/v26.0/301');
    fetcher.mockResolvedValueOnce(json({success:true}));expect(await graph.publish(d)).toBe('301');
    fetcher.mockResolvedValueOnce(json({status:{publishing_phase:{status:'not_started'}}})).mockResolvedValueOnce(json({status:{publishing_phase:{status:'complete'}},permalink_url:'https://www.facebook.com/reel/301'}));
    expect((await graph.verify(d)).confirmed).toBe(false);expect((await graph.verify(d)).confirmed).toBe(true);
  });
});
