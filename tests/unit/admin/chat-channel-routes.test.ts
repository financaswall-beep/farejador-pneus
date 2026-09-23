import Fastify from 'fastify';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const health=vi.hoisted(()=>vi.fn());
vi.mock('../../../src/admin/chatwoot-channel-health.js',()=>({getChatwootChannelHealth:health}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{MATRIZ_CUSTOMER_IDENTITY:true,FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{query:vi.fn()}}));
vi.mock('../../../src/atendente-v2/outbound-worker.js',()=>({pollBotOutbox:vi.fn()}));
vi.mock('../../../src/admin/painel/bot-conversation-control.js',()=>({changeBotConversationControl:vi.fn()}));
vi.mock('../../../src/admin/painel/customer-lead-avatar.js',()=>({getCustomerLeadAvatar:vi.fn()}));
vi.mock('../../../src/admin/painel/customer-detail.js',()=>({getCustomerDetail:vi.fn()}));
vi.mock('../../../src/admin/caixa/chat-queries.js',()=>({getOperationConversation:vi.fn(),getOperationMessages:vi.fn(),listOperationConversations:vi.fn(),requireChatConversation:vi.fn()}));
vi.mock('../../../src/admin/caixa/chat-send.js',()=>({queueOperatorMessage:vi.fn(),retryOperatorMessage:vi.fn()}));
vi.mock('../../../src/admin/caixa/chat-media.js',()=>({parseOperatorMedia:vi.fn(),CHAT_MEDIA_MAX:16777216}));
vi.mock('../../../src/admin/painel/route-bot-control.js',()=>({registerBotControlRoutes:vi.fn()}));
vi.mock('../../../src/admin/painel/route-bot-delivery.js',()=>({registerBotDeliveryRoutes:vi.fn()}));
vi.mock('../../../src/admin/painel/route-bot-faltas.js',()=>({registerBotShortageRoutes:vi.fn()}));
vi.mock('../../../src/admin/painel/route-demand-report.js',()=>({registerDemandReportRoutes:vi.fn()}));
vi.mock('../../../src/admin/painel/route-shortage-report.js',()=>({registerShortageReportRoutes:vi.fn()}));
vi.mock('../../../src/admin/painel/queries.js',()=>({getBotCampainha:vi.fn(),getBotMovement:vi.fn(),getBotResilience:vi.fn(),getBotVisao:vi.fn(),reprocessBotDeadLetter:vi.fn(),resolveBotDeadLetter:vi.fn()}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:async(req:any,reply:any)=>{
  if(req.headers.authorization!=='fixture')return reply.code(401).send({error:'unauthorized'});
},requireAdminOwner:vi.fn()}));
import {registerCaixaChatRoutes} from '../../../src/admin/caixa/route-chat.js';
import {registerCaixaStaticRoutes} from '../../../src/admin/caixa/route-static.js';
import {registerPainelBot} from '../../../src/admin/painel/route-bot.js';
import {registerPainelStatic} from '../../../src/admin/painel/route-static.js';
beforeEach(()=>{vi.clearAllMocks();health.mockResolvedValue({status:'ok',checked_at:null,channels:[]});});
async function app(){
  const app=Fastify();registerCaixaChatRoutes(app,async()=>{},async(req:any,reply)=>{
    if(!req.headers.authorization)return void reply.code(401).send({error:'unauthorized'});
    req.caixa={panelRole:req.headers.authorization==='fixture'?'owner':'employee',modules:{vendas:true}};
  });await registerPainelBot(app);return app;
}
describe('acesso aos avisos de conexão',()=>{
  it('recusa leitura anônima nas duas interfaces',async()=>{
    const server=await app();try{for(const url of ['/api/caixa/chat/channels','/admin/api/bot/channels']){
      expect((await server.inject({url})).statusCode).toBe(401);
    }expect(health).not.toHaveBeenCalled();}finally{await server.close();}
  });
  it('mantém proteção de identidade do app e não consulta o provedor para funcionário sem acesso',async()=>{
    const server=await app();try{expect((await server.inject({url:'/api/caixa/chat/channels',headers:{authorization:'employee'}})).statusCode).toBe(403);
      expect(health).not.toHaveBeenCalled();}finally{await server.close();}
  });
  it('usa somente a configuração interna e proíbe cache público',async()=>{
    const server=await app();try{for(const url of ['/api/caixa/chat/channels?account_id=999&environment=prod','/admin/api/bot/channels']){
      const response=await server.inject({url,headers:{authorization:'fixture'}});
      expect(response.statusCode,response.body).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({status:'ok',checked_at:null,channels:[]});
    }expect(health.mock.calls).toEqual([[],[]]);}finally{await server.close();}
  });
  it('serve os novos assets nas rotas reais do app e do painel',async()=>{
    const server=Fastify();registerCaixaStaticRoutes(server,async()=>{});await registerPainelStatic(server);
    try{for(const prefix of ['/operacao/','/admin/painel/'])for(const file of ['chat-channel-alerts.js','chat-channel-alerts.css',
      prefix==='/operacao/'?'caixa-chat-channels.js':'app.bot.channels.js']){
      const response=await server.inject({url:prefix+file});expect(response.statusCode,response.body).toBe(200);
      expect(response.headers['content-type']).toContain(file.endsWith('.css')?'text/css':'text/javascript');
    }}finally{await server.close();}
  });
});
