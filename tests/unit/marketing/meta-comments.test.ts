import { describe,it,expect,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',OPENAI_MODEL:'test-model'}}));
import { extractComments } from '../../../src/social-comments/extract.js';
import { CommentsGraph,MetaCommentError,safePostUrl } from '../../../src/social-comments/graph.js';
import { decideComment,decisionSchema,minimizePublicText } from '../../../src/social-comments/ai.js';

const config = {enabled:true,publish:true,pageId:'100',instagramId:'200',token:'secret-token',appSecret:'secret-app',apiVersion:'v21.0'};
function fb(value:Record<string,unknown> = {},account='100') {
  return {object:'page',entry:[{id:account,time:1770000000,changes:[{field:'feed',value:{item:'comment',verb:'add',comment_id:'100_90',post_id:'100_80',parent_id:'100_80',message:'Qual a medida?',from:{id:'300',name:'Cliente fictício'},...value}}]}]};
}
describe('comentários Meta — entrada e escopo',()=>{
  it('normaliza feed Facebook sem interpretar texto',()=>{
    expect(extractComments(fb(),config)[0]).toMatchObject({platform:'facebook',commentId:'100_90',postId:'100_80',parentId:null,own:false,removed:false,body:'Qual a medida?'});
  });
  it('normaliza comments Instagram',()=>{
    expect(extractComments({object:'instagram',entry:[{id:'200',time:1770000000,changes:[{field:'comments',value:{id:'456',media:{id:'789'},text:'Muito bom!',from:{id:'300',username:'ficticio'}}}]}]},config)[0])
      .toMatchObject({platform:'instagram',commentId:'456',postId:'789',authorLabel:'ficticio'});
  });
  it('rejeita outra página, eventos de mensagens e IDs que virariam caminhos',()=>{
    expect(extractComments(fb({},'999'),config)).toEqual([]);
    expect(extractComments(fb({comment_id:'../me'}),config)).toEqual([]);
    expect(extractComments(fb({item:'post'}),config)).toEqual([]);
    expect(extractComments({object:'page',entry:[{id:'100',messaging:[{message:{text:'oi'}}]}]},config)).toEqual([]);
  });
  it('marca exclusões e comentários da própria conta',()=>{
    expect(extractComments(fb({verb:'remove',message:undefined}),config)[0]?.removed).toBe(true);
    expect(extractComments(fb({from:{id:'100'}}),config)[0]?.own).toBe(true);
  });
});
describe('transporte oficial Meta',()=>{
  it.each([['facebook','comments'],['instagram','replies']] as const)('responde no endpoint de %s',async(platform,edge)=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({id:'123_456'}));
    const result=await new CommentsGraph(config,fetcher).reply(platform,'123','Obrigado!');
    expect(result).toBe('123_456');
    const [url,options]=fetcher.mock.calls[0]!;
    expect(url.pathname).toBe(`/v21.0/123/${edge}`);
    expect(url.toString()).not.toContain('secret-token');
    expect(options.method).toBe('POST');
    expect(new URLSearchParams(options.body).get('message')).toBe('Obrigado!');
    expect(options.redirect).toBe('error');
  });
  it('só confirma exclusão quando a Meta devolve sucesso',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({success:true}));
    await new CommentsGraph(config,fetcher).remove('123');
    expect(fetcher.mock.calls[0]![1].method).toBe('DELETE');
    await expect(new CommentsGraph(config,vi.fn().mockResolvedValue(Response.json({success:false}))).remove('123'))
      .rejects.toMatchObject({code:'meta_delete_ack_unknown',uncertain:true});
  });
  it('timeout e 5xx de escrita são incertos, sem expor tokens nem conteúdo',async()=>{
    await expect(new CommentsGraph(config,vi.fn().mockRejectedValue(new Error('secret-token'))).reply('facebook','123','Texto privado'))
      .rejects.toMatchObject({code:'meta_connection_unknown',uncertain:true});
    await expect(new CommentsGraph(config,vi.fn().mockResolvedValue(Response.json({error:{code:2,message:'secret-token'}},{status:500}))).remove('123'))
      .rejects.toMatchObject({code:'meta_http_500_code_2',uncertain:true});
  });
  it('confere dono da publicação antes de usá-la',async()=>{
    const graph=new CommentsGraph(config,vi.fn().mockResolvedValue(Response.json({id:'88',from:{id:'999'},message:'Teste'})));
    await expect(graph.post('facebook','100','88')).rejects.toMatchObject({code:'meta_post_owner_mismatch'});
    await expect(graph.post('facebook','999','88')).rejects.toBeInstanceOf(MetaCommentError);
  });
  it('só entrega links de posts em domínios oficiais',()=>{
    expect(safePostUrl('javascript:alert(1)')).toBeNull();
    expect(safePostUrl('https://facebook.com.evil.test/a')).toBeNull();
    expect(safePostUrl('https://www.instagram.com/p/test/')).toBe('https://www.instagram.com/p/test/');
  });
  it('não declara permissões verificadas sem diagnóstico do token',async()=>{
    const health=await new CommentsGraph(config,vi.fn().mockResolvedValue(Response.json({id:'100',instagram_business_account:{id:'200'}}))).health();
    expect(health).toMatchObject({page_matches:true,instagram_matches:true,permissions_checked:false,facebook_missing:null});
  });
  it('identifica a assinatura inválida sem expor a mensagem da Meta',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({error:{code:100,message:'Invalid appsecret_proof: secret-token'}},{status:400}));
    await expect(new CommentsGraph(config,fetcher).health()).rejects.toMatchObject({
      code:'meta_app_secret_mismatch',message:'meta_app_secret_mismatch',stage:'page',uncertain:false,
    });
  });
  it('distingue falha nas permissões de falha ao consultar a página',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({id:'100'}))
      .mockResolvedValueOnce(Response.json({error:{code:190,message:'secret-app'}},{status:400}));
    await expect(new CommentsGraph({...config,appId:'123'},fetcher).health()).rejects.toMatchObject({
      code:'meta_http_400_code_190',stage:'token_permissions',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe('decisões de IA',()=>{
  const decision={action:'delete',sentiment:'negative',reply_text:'',reason:'Reclamação sobre o atendimento.',confidence_level:'high'};
  it('valida decisão estruturada e preserva o modelo retornado',async()=>{
    const request=vi.fn().mockResolvedValue({status:'completed',model:'modelo-retornado',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(decision)}]}],usage:{input_tokens:100,output_tokens:40}});
    const result=await decideComment('Atendimento péssimo','Pneus para sua moto',request);
    expect(result).toMatchObject({decision,model:'modelo-retornado',inputTokens:100,outputTokens:40});
    const sent=JSON.parse(request.mock.calls[0]![0]);
    expect(sent.store).toBe(false); expect(sent.tools).toBeUndefined();
    expect(sent.text.format.strict).toBe(true);
  });
  it('rejeita exclusão de sentimento neutro e decisão contraditória',()=>{
    expect(decisionSchema.safeParse({...decision,sentiment:'neutral'}).success).toBe(false);
    expect(decisionSchema.safeParse({...decision,action:'reply',reply_text:'Obrigado!'}).success).toBe(false);
  });
  it('recusa resposta incompleta e recusa do provedor',async()=>{
    await expect(decideComment('oi','post',async()=>({status:'incomplete',output:[]}))).rejects.toThrow();
    await expect(decideComment('oi','post',async()=>({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}))).rejects.toThrow('comment_ai_refusal');
  });
  it('minimiza dados pessoais comuns sem perder medidas de pneus',()=>{
    const minimized=minimizePublicText('130/70-13 e 175/65R14. +55 (21) 99999-0000 nome@example.test @perfil');
    expect(minimized).toContain('130/70-13 e 175/65R14');
    expect(minimized).not.toContain('99999');expect(minimized).not.toContain('example.test');expect(minimized).not.toContain('@perfil');
  });
});
