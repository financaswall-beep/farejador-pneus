import {beforeEach,describe,expect,it,vi} from 'vitest';
const settings=vi.hoisted(()=>({META_COMMENTS_ENABLED:true,META_COMMENTS_PUBLISH_ENABLED:true,
  META_COMMENTS_PAGE_ID:undefined as string|undefined,META_COMMENTS_INSTAGRAM_ID:undefined as string|undefined}));
vi.mock('../../../src/shared/config/env.js',()=>({env:settings}));
import {COMMENT_ACCOUNTS,commentsConfig,ownsAccount} from '../../../src/social-comments/config.js';
import {extractComments} from '../../../src/social-comments/extract.js';
import {CommentsGraph} from '../../../src/social-comments/graph.js';

describe('escopo exclusivo 2W Pneus e @2wp.pneus',()=>{
  beforeEach(()=>Object.assign(settings,{META_COMMENTS_ENABLED:true,META_COMMENTS_PUBLISH_ENABLED:true,META_COMMENTS_PAGE_ID:undefined,META_COMMENTS_INSTAGRAM_ID:undefined}));
  it('fixa as duas contas mesmo sem variáveis de ID',()=>{
    expect(commentsConfig()).toMatchObject({pageId:'1434857906367394',instagramId:'17841465774227389',enabled:true,publish:true,scopeValid:true});
  });
  it.each(['META_COMMENTS_PAGE_ID','META_COMMENTS_INSTAGRAM_ID'] as const)('outro ID em %s bloqueia toda a automação',key=>{
    settings[key]='999';const config=commentsConfig();
    expect(config).toMatchObject({enabled:false,publish:false,scopeValid:false});
    expect(ownsAccount(config,'facebook','999')).toBe(false);
    expect(ownsAccount(config,'instagram','999')).toBe(false);
    expect(ownsAccount(config,'facebook',COMMENT_ACCOUNTS.facebook.id)).toBe(false);
  });
  it('aceita variáveis que confirmam exatamente as contas autorizadas',()=>{
    settings.META_COMMENTS_PAGE_ID=COMMENT_ACCOUNTS.facebook.id;
    settings.META_COMMENTS_INSTAGRAM_ID=COMMENT_ACCOUNTS.instagram.id;
    expect(commentsConfig().scopeValid).toBe(true);
  });
  it('não confunde IDs entre redes nem usa o Instagram diferente vinculado ao Facebook',()=>{
    const config=commentsConfig();
    expect(ownsAccount(config,'facebook',COMMENT_ACCOUNTS.instagram.id)).toBe(false);
    expect(ownsAccount(config,'instagram',COMMENT_ACCOUNTS.facebook.id)).toBe(false);
    const entry=(id:string)=>({id,changes:[{field:'comments',value:{id:'900',media:{id:'901'},text:'Preço?',from:{id:'902'}}}]});
    const events=extractComments({object:'instagram',entry:[entry('17841445872943671'),entry('999'),entry(COMMENT_ACCOUNTS.instagram.id)]},config);
    expect(events).toHaveLength(1);
    expect(events[0].accountId).toBe(COMMENT_ACCOUNTS.instagram.id);
  });
  it('ignora outra página mesmo no mesmo lote de eventos da 2W Pneus',()=>{
    const entry=(id:string)=>({id,changes:[{field:'feed',value:{item:'comment',verb:'add',post_id:id+'_1',comment_id:id+'_2',message:'Oi'}}]});
    const events=extractComments({object:'page',entry:[entry('999'),entry(COMMENT_ACCOUNTS.facebook.id)]},commentsConfig());
    expect(events).toHaveLength(1);
    expect(events[0].accountId).toBe(COMMENT_ACCOUNTS.facebook.id);
  });
  it('recusa token de outra página antes de qualquer escrita',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({id:'999'}));
    const graph=new CommentsGraph({...commentsConfig(),token:'ficticio',apiVersion:'v21.0'},fetcher);
    await expect(graph.assertAccount('facebook',COMMENT_ACCOUNTS.facebook.id)).rejects.toMatchObject({code:'meta_token_page_mismatch'});
    expect(fetcher.mock.calls.every(([,options])=>options.method==='GET')).toBe(true);
  });
  it('recusa o Instagram diferente vinculado ao token e aceita somente @2wp.pneus',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({id:COMMENT_ACCOUNTS.facebook.id,instagram_business_account:{id:'17841445872943671'}}))
      .mockResolvedValueOnce(Response.json({id:COMMENT_ACCOUNTS.facebook.id,instagram_business_account:{id:COMMENT_ACCOUNTS.instagram.id}}));
    const graph=new CommentsGraph({...commentsConfig(),token:'ficticio',apiVersion:'v21.0'},fetcher);
    await expect(graph.assertAccount('instagram',COMMENT_ACCOUNTS.instagram.id)).rejects.toMatchObject({code:'meta_token_instagram_mismatch'});
    await expect(graph.assertAccount('instagram',COMMENT_ACCOUNTS.instagram.id)).resolves.toBeUndefined();
    expect(fetcher.mock.calls.every(([,options])=>options.method==='GET')).toBe(true);
  });
});
