import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),query:vi.fn(),list:vi.fn(),detail:vi.fn(),messages:vi.fn(),require:vi.fn(),send:vi.fn(),retry:vi.fn(),control:vi.fn(),customer:vi.fn(),interests:vi.fn(),media:vi.fn(),wake:vi.fn()}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',MATRIZ_CUSTOMER_IDENTITY:true,ADMIN_BEARER_FALLBACK_ENABLED:false}}));
vi.mock('../../../src/admin/session.js',()=>({ADMIN_SESSION_COOKIE:'farejador_admin',validateMatrizAdminSession:m.session}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{query:m.query}}));
vi.mock('../../../src/admin/caixa/chat-queries.js',()=>({listOperationConversations:m.list,getOperationConversation:m.detail,getOperationMessages:m.messages,requireChatConversation:m.require}));
vi.mock('../../../src/admin/caixa/chat-send.js',()=>({queueOperatorMessage:m.send,retryOperatorMessage:m.retry}));
vi.mock('../../../src/admin/caixa/chat-media.js',()=>({parseOperatorMedia:m.media,CHAT_MEDIA_MAX:16777216}));
vi.mock('../../../src/admin/painel/bot-conversation-control.js',()=>({changeBotConversationControl:m.control}));
vi.mock('../../../src/admin/painel/customer-detail.js',()=>({getCustomerDetail:m.customer}));
vi.mock('../../../src/admin/caixa/chat-customer-interests.js',()=>({getOperationCustomerInterests:m.interests}));
vi.mock('../../../src/admin/painel/customer-lead-avatar.js',()=>({getCustomerLeadAvatar:vi.fn()}));
vi.mock('../../../src/admin/chatwoot-channel-health.js',()=>({getChatwootChannelHealth:vi.fn().mockResolvedValue({channels:[]})}));
vi.mock('../../../src/atendente-v2/outbound-worker.js',()=>({pollBotOutbox:m.wake}));
vi.mock('../../../src/admin/route-stock-waitlist.js',()=>({registerStockWaitlistRoutes:vi.fn()}));
import { registerBotChatRoutes } from '../../../src/admin/painel/route-bot-chat.js';
import { env } from '../../../src/shared/config/env.js';
const id='00000000-0000-4000-8000-000000000001',token='00000000-0000-4000-8000-000000000002';
const prefix='/admin/api/bot/chat',url=prefix+'/conversations/'+id;
const headers={cookie:'farejador_admin=fixture',origin:'http://localhost:80'};
beforeEach(()=>{
  vi.clearAllMocks();env.MATRIZ_CUSTOMER_IDENTITY=true;
  m.session.mockResolvedValue({authType:'session',personId:'owner',role:'owner',modules:['bot'],displayName:'Dono'});
  m.query.mockResolvedValue({rows:[{ready:true}]});m.require.mockResolvedValue({contact_id:'contact'});
  m.list.mockResolvedValue({rows:[],total:0,needs_total:0,has_more:false});
  m.messages.mockResolvedValue({messages:[],outgoing:[],next:null});m.detail.mockResolvedValue({id,mode:'auto',version:1});
  m.send.mockResolvedValue({id:token,status:'pending'});m.wake.mockResolvedValue(undefined);
  m.customer.mockResolvedValue({customer:{name:'Fixture'},orders:[],summary:{purchases:2,total_spent:200}});
  m.interests.mockResolvedValue([{measure:'175/65R14'}]);m.control.mockResolvedValue({mode:'human',version:2});
});
async function app(){const app=Fastify();registerBotChatRoutes(app);await app.ready();return app;}
describe('chat no painel Bot usa sessão administrativa e o motor da Operação',()=>{
  it('recusa acesso anônimo, inclusive ao stream, antes de consultar dados',async()=>{
    const server=await app();try{
      for(const path of [prefix+'/conversations',url+'/messages',url+'/customer',prefix+'/stream'])expect((await server.inject({url:path})).statusCode).toBe(401);
      expect(m.query).not.toHaveBeenCalled();expect(m.messages).not.toHaveBeenCalled();
    }finally{await server.close();}
  });
  it('não aceita sessão de parceiro como sessão administrativa',async()=>{
    m.session.mockResolvedValue(null);const server=await app();try{
      expect((await server.inject({url,headers})).statusCode).toBe(401);expect(m.detail).not.toHaveBeenCalled();
    }finally{await server.close();}
  });
  it('exige módulo Bot e respeita a restrição de identidade ao dono',async()=>{
    const server=await app();try{
      m.session.mockResolvedValue({authType:'session',personId:'staff',role:'admin',modules:['vendas']});
      expect((await server.inject({url,headers})).statusCode).toBe(403);
      m.session.mockResolvedValue({authType:'session',personId:'staff',role:'admin',modules:['bot']});
      expect((await server.inject({url,headers})).statusCode).toBe(403);
      env.MATRIZ_CUSTOMER_IDENTITY=false;
      expect((await server.inject({url,headers})).statusCode).toBe(200);
      expect(m.detail).toHaveBeenCalledTimes(1);
    }finally{await server.close();}
  });
  it('bloqueia escrita de outra origem e não recebe ator ou ambiente do navegador',async()=>{
    const server=await app();try{
      const payload={client_token:token,content:'Olá'};
      expect((await server.inject({method:'POST',url:url+'/messages',headers:{...headers,origin:'https://other.example'},payload})).statusCode).toBe(403);
      for(const extra of [{actor:'outro'},{environment:'prod'}])expect((await server.inject({method:'POST',url:url+'/messages',headers,payload:{...payload,...extra}})).statusCode).toBe(400);
      expect(m.send).not.toHaveBeenCalled();
    }finally{await server.close();}
  });
  it('reutiliza fila idempotente, ator autenticado, validação de mídia e pedido de foto',async()=>{
    const server=await app();try{
      const file={mime:'image/jpeg',base64:'fixture'};m.media.mockResolvedValue({mime:'image/jpeg',bytes:Buffer.from('photo')});
      const response=await server.inject({method:'POST',url:url+'/messages',headers,payload:{client_token:token,content:'Foto',file,photo_request_id:id}});
      expect(response.statusCode,response.body).toBe(202);
      expect(m.require).toHaveBeenCalledWith(id);expect(m.media).toHaveBeenCalledWith(file);
      expect(m.send).toHaveBeenCalledWith({conversationId:id,clientToken:token,actor:'admin:owner',content:'Foto',file:{mime:'image/jpeg',bytes:Buffer.from('photo')},photoRequestId:id});
      expect(m.wake).toHaveBeenCalledTimes(1);
    }finally{await server.close();}
  });
  it('consulta ficha e interesses do mesmo cliente sem permitir escolha de ambiente',async()=>{
    const server=await app();try{
      const response=await server.inject({url:url+'/customer?environment=prod',headers});
      expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
      expect(m.customer).toHaveBeenCalledWith('test','chatwoot','contact',{offset:0});expect(m.interests).toHaveBeenCalledWith('test',id);
      expect(response.json().summary.purchases).toBe(2);
    }finally{await server.close();}
  });
  it('assume e retoma a conversa pelo mesmo controle com versão, sem mensagem pública',async()=>{
    const server=await app();try{
      const response=await server.inject({method:'POST',url:url+'/control',headers,payload:{action:'takeover',expected_version:1}});
      expect(response.statusCode,response.body).toBe(200);
      expect(m.control).toHaveBeenCalledWith({conversationId:id,action:'takeover',expectedVersion:1,actor:'admin:owner'});expect(m.send).not.toHaveBeenCalled();
      m.control.mockRejectedValue(Error('bot_control_conflict'));
      expect((await server.inject({method:'POST',url:url+'/control',headers,payload:{action:'resume',expected_version:1}})).statusCode).toBe(409);
    }finally{await server.close();}
  });
});
