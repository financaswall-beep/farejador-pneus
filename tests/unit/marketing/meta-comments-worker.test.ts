import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/social-comments/store.js',()=>({
  claimComment:vi.fn(),commentsPaused:vi.fn(),finishComment:vi.fn(),recoverCommentLeases:vi.fn(),saveDecision:vi.fn(),
}));
import { processComment, publishComment } from '../../../src/social-comments/worker.js';
import { claimComment, commentsPaused, finishComment, saveDecision, type CommentTask } from '../../../src/social-comments/store.js';
import { COMMENT_PROMPT_VERSION } from '../../../src/social-comments/prompt.js';
import { commentRevision } from '../../../src/social-comments/extract.js';

const config = {enabled:true,publish:true,pageId:'100',instagramId:'200',apiVersion:'v21.0'};
const body = 'Tem 130/70-13?';
const base:CommentTask = {id:'uuid',platform:'instagram',account_id:'200',comment_id:'c1',post_id:'p1',author_id:'300',body,
  revision:commentRevision(body),decision_id:'decision',action:'reply',reply_text:'Resposta atual',
  decision_revision:commentRevision(body),attempts:0,lease_id:'lease',decision_version:COMMENT_PROMPT_VERSION,
  decision_created_at:new Date()};
const graph:any = {assertAccount:vi.fn(),post:vi.fn(),comment:vi.fn(),reply:vi.fn(),remove:vi.fn()};
const pool:any = {query:vi.fn(),connect:vi.fn()};
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(claimComment).mockResolvedValue({...base,decision_created_at:new Date()});
  vi.mocked(commentsPaused).mockResolvedValue(false);
  graph.post.mockResolvedValue({caption:'Pneus para sua moto',url:'https://www.instagram.com/p/test/'});
  graph.comment.mockResolvedValue({body,authorId:'300'});
  graph.reply.mockResolvedValue('reply1');
  pool.query.mockResolvedValue({rowCount:1,rows:[{}]});
});

describe('worker de comentários com consultas comerciais',()=>{
  it('gera resposta com plataforma correta e consultas limitadas ao ambiente do servidor',async()=>{
    const ai:any = {decision:{action:'reply',reply_text:'Teste'},model:'test',inputTokens:10,outputTokens:10};
    const decide=vi.fn().mockResolvedValue(ai);
    await processComment({pool,config,graph,decide});
    expect(decide).toHaveBeenCalledWith(body,'Pneus para sua moto',undefined,
      {platform:'instagram',lookup:expect.any(Function)});
    const lookup=decide.mock.calls[0]![3].lookup;
    await expect(lookup('criar_pedido',{})).rejects.toThrow('comment_tool_not_allowed');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(saveDecision).toHaveBeenCalledWith(pool,expect.objectContaining({id:'uuid'}),ai,'https://www.instagram.com/p/test/');
    expect(graph.reply).not.toHaveBeenCalled();
  });
  it.each([
    {decision_created_at:new Date(Date.now()-6*60_000)},
    {decision_version:'meta-comments-v2'},
    {decision_created_at:null},
    {decision_created_at:'invalid'},
    {decision_version:'meta-comments-v2',action:'delete' as const},
  ])('reanalisa decisão desatualizada sem publicar: %j',async patch=>{
    vi.mocked(claimComment).mockResolvedValue({...base,...patch});
    await publishComment({pool,config,graph});
    expect(finishComment).toHaveBeenCalledWith(pool,expect.anything(),'sending','pending','commercial_data_expired');
    expect(graph.reply).not.toHaveBeenCalled();
    expect(graph.remove).not.toHaveBeenCalled();
    expect(graph.assertAccount).not.toHaveBeenCalled();
  });
  it('resposta recente continua conferindo conta, comentário e lease antes de publicar',async()=>{
    await publishComment({pool,config,graph});
    expect(graph.assertAccount).toHaveBeenCalledWith('instagram','200');
    expect(graph.comment).toHaveBeenCalledWith('instagram','c1');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("a.status='sending'"),['test','uuid',base.revision,'lease']);
    expect(graph.reply).toHaveBeenCalledExactlyOnceWith('instagram','c1','Resposta atual');
    expect(finishComment).toHaveBeenCalledWith(pool,expect.anything(),'sending','replied',null,'reply1');
  });
  it('não publica se humano encerrou pendência nem responde a outra conta',async()=>{
    pool.query.mockResolvedValue({rowCount:0,rows:[]});
    await publishComment({pool,config,graph});
    expect(graph.reply).not.toHaveBeenCalled();
    vi.mocked(claimComment).mockResolvedValue({...base,account_id:'outra-conta'});
    const decide=vi.fn();
    await processComment({pool,config,graph,decide});
    expect(decide).not.toHaveBeenCalled();
    expect(finishComment).toHaveBeenCalledWith(pool,expect.anything(),'generating','ignored','account_not_eligible');
  });
});
