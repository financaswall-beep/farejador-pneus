import { z } from 'zod';

const booleanStringSchema = z.enum(['true', 'false']).default('false').transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FAREJADOR_ENV: z.enum(['prod', 'test']),
  PORT: z.string().transform(Number).pipe(z.number().int().min(1).max(65535)).default('3000'),
  DATABASE_URL: z.string().min(1),
  // Etapa 5 da auditoria 2026-05-21: pool separado pro Portal Parceiro com
  // role sem BYPASSRLS. Opcional pra nao quebrar ambientes que ainda nao
  // configuraram (dev/test/staging). Em prod, deve estar setado.
  PARTNER_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.string().transform(Number).pipe(z.number().int().min(1)).default('10'),
  DATABASE_SSL: booleanStringSchema,
  CHATWOOT_HMAC_SECRET: z.string().min(1),
  CHATWOOT_WEBHOOK_MAX_AGE_SECONDS: z.string().transform(Number).pipe(z.number().int().min(1)).default('300'),
  CHATWOOT_API_BASE_URL: z.string().min(1).optional(),
  CHATWOOT_API_TOKEN: z.string().min(1).optional(),
  CHATWOOT_ACCOUNT_ID: z.string().transform(Number).pipe(z.number().int()).optional(),
  ADMIN_AUTH_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  SIGNAL_TIMEZONE: z.string().min(1).default('America/Sao_Paulo'),
  // OpenAI (usado pelo Agent V2)
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_TIMEOUT_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('30000'),
  SKIP_EVENT_TYPES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  // Agent V2 Worker (substitui ATENDENTE_SHADOW_*): poll de ops.atendente_jobs,
  // executa runAgentV2 e marca job processed/failed.
  AGENT_V2_WORKER_ENABLED: booleanStringSchema,
  // Chat unificado do Portal Parceiro (Fatia 1): espelha mensagens do Chatwoot em
  // commerce.partner_messages durante a normalizacao. Defensivo e isolado por SAVEPOINT
  // — nunca quebra a normalizacao core. Desligado por padrao.
  PARTNER_CHAT_FANOUT_ENABLED: booleanStringSchema,
  // Fase 2 — Motor de distribuição da Rede (roteamento multi-parceiro). Cada flag
  // DESLIGADA = comportamento de hoje (1 loja por município, LIMIT 1). Liga-se uma
  // por vez, provada no env `test`. Ver docs/FASE2_MOTOR_DISTRIBUICAO_2026-06-06.md.
  //
  // Considera TODOS os parceiros que cobrem a região (não só o mais antigo) e tenta
  // o 2º antes de cair na matriz. Off = decideStoreForItems de hoje, intocado.
  ROUTING_MULTI_CANDIDATE: booleanStringSchema,
  // Ordena os candidatos pela régua de justiça (quem recebeu menos lead em 7d).
  // Só tem efeito com ROUTING_MULTI_CANDIDATE ligada. Off = ordem da query.
  ROUTING_FAIRNESS: booleanStringSchema,
  // Camada GEO — escolhe a loja por PROXIMIDADE real (anel em km que cresce),
  // não por cidade inteira. Ver docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md.
  // DESLIGADA = roteamento de hoje, byte a byte. Só tem efeito com candidato +
  // coordenada do cliente; sem coordenada cai no caminho atual (fallback por cidade).
  ROUTING_GEO: booleanStringSchema,
  // Usa a distância de RUA do Google (Distance Matrix) em vez de linha reta.
  // Só efeito com ROUTING_GEO on. Off = haversine (linha reta). Liga-se DEPOIS, sozinha.
  ROUTING_GEO_ROAD_DISTANCE: booleanStringSchema,
  // Retirada (pickup) roteada pro PARCEIRO pelos mesmos critérios da entrega
  // (proximidade + régua de justiça), RESERVANDO o pneu até o cliente retirar — em vez
  // de cair na matriz sem segurar nada. Default OFF = retirada vai pra matriz (hoje).
  // Só tem efeito com ROUTING_GEO on + coordenada do cliente (pino ou geocode do bairro).
  PICKUP_TO_PARTNER: booleanStringSchema,
  // PROXIMIDADE-PRIMEIRO — derruba o "muro da cidade": com a flag on + coordenada do
  // cliente, os candidatos passam a ser TODAS as lojas ativas com coordenada (sem gate
  // de município), e o anel/estoque/régua decidem por DISTÂNCIA. Resolve a divisa
  // (Caxias a 9 km de Madureira deixava de cair na matriz). Ver
  // docs/SESSAO_2026-06-09b_PROXIMIDADE_HANDOFF.md §2. DESLIGADA = roteamento por cidade
  // de hoje, byte a byte. Nesta leva só age na RETIRADA (modalidade='pickup'); a entrega
  // segue por cidade até a Fase 3 (precisa do raio por loja).
  ROUTING_PROXIMITY_FIRST: booleanStringSchema,
  // FOTO SOB DEMANDA — cliente pede foto do pneu usado, bot cria pedido de foto
  // (commerce.photo_requests, 0094), card aparece no painel do parceiro, borracheiro
  // fotografa e o sistema manda a foto pro cliente sozinho (Chatwoot). Default OFF =
  // dormente: bot não cria pedido, expirador não roda, endpoints do painel respondem
  // vazio/404. Ver docs/PLANO_FOTO_SOB_DEMANDA_2026-06-10.md.
  PHOTO_REQUESTS: booleanStringSchema,
  // PESQUISA DE SATISFAÇÃO (estrelas) — quando o parceiro marca entregue/retirado, o
  // sistema pergunta a nota (1-5) ao cliente no WhatsApp (commerce.satisfaction_surveys,
  // 0105) e guarda por loja (ranking interno/discreto). Default OFF = dormente: não
  // enfileira, dispatcher não roda, captura inerte. Liga só quando o dono mandar.
  SATISFACTION_SURVEY: booleanStringSchema,
  // ATACADO Fase 2b — BAIXA no estoque do galpão por medida. Quando a Matriz registra
  // uma venda de atacado, decrementa commerce.wholesale_stock pela medida (clamp em 0:
  // a venda NUNCA trava por falta de estoque; medida não cadastrada simplesmente não
  // baixa). Default OFF = dormente: a venda registra igual, mas não mexe no estoque —
  // deixa o dono cadastrar o galpão real antes de ligar. Liga quando o estoque for real.
  WHOLESALE_STOCK_DECREMENT: booleanStringSchema,
  // ATACADO × VAREJO — ESTOQUE ÚNICO (unificação do galpão). O dono é atacadista com UM
  // galpão físico que vende em dois canais (atacado p/ borracheiro + varejo via bot). Com a
  // flag ON, quando o bot roteia um cliente pra MATRIZ (slug='main'), ele passa a conferir e
  // baixar o estoque do GALPÃO (commerce.wholesale_stock, por MEDIDA) em vez da semente
  // commerce.stock_levels — atacado e varejo saem do MESMO monte. O estoque dos PARCEIROS
  // (partner_stock_levels) NÃO muda (trava do dono). Default OFF = dormente: matriz lê
  // stock_levels como hoje. Liga quando o galpão real estiver cadastrado e provado.
  WHOLESALE_UNIFIED_STOCK: booleanStringSchema,
  // VAREJO DA MATRIZ — BAIXA do galpão. Quando a MATRIZ (slug='main') vende no VAREJO
  // (balcão ou bot), abate commerce.wholesale_stock por medida (produto→tire_size→tireSizeKey,
  // clamp em 0: a venda NUNCA trava). É a "outra metade" da unificação (a leitura já existe).
  // SÓ a matriz; partner_stock_levels JAMAIS é tocado. Default OFF = dormente: a venda registra
  // mas não mexe no galpão (estado de hoje). Liga quando o estoque real estiver cadastrado e provado.
  WHOLESALE_MATRIZ_DECREMENT: booleanStringSchema,
  // MATRIZ COMO LOJA — a matriz entra no anel de proximidade igual a qualquer parceiro,
  // com a coordenada do galpão (Petiti/SG) e o estoque do GALPÃO (commerce.wholesale_stock,
  // mesma régua do WHOLESALE_UNIFIED_STOCK). Ela NUNCA bate um parceiro no mesmo anel
  // (fairness máxima — zero leads recebidos). Só vence quando nenhum parceiro está no pool
  // do anel E o galpão tem todos os itens. Requer WHOLESALE_UNIFIED_STOCK on. Default OFF =
  // matriz segue como backstop passivo (comportamento de hoje). Liga no Coolify após provar ao vivo.
  ROUTING_MATRIZ_AS_STORE: booleanStringSchema,
  // PUSH (PWA) — notificação nativa do celular pro borracheiro quando cai FOTO ou
  // PEDIDO novo, mesmo com o navegador FECHADO (o "ajudante"/service worker é
  // acordado pelo push do navegador). O som da página (app.foto.js) só toca com a
  // aba aberta; isto cobre o aparelho no bolso. Default OFF = dormente: endpoints
  // respondem {enabled:false}, disparador não engata, nada é gravado/enviado. Liga
  // só quando o dono colar as chaves VAPID no Coolify e provar ao vivo.
  PUSH_NOTIFICATIONS: booleanStringSchema,
  // Par de chaves VAPID (Voluntary Application Server Identification) — a
  // "identidade" que autoriza ESTE servidor a mandar push pros aparelhos inscritos.
  // A PÚBLICA vai pro front (usada na inscrição) via endpoint; a PRIVADA NUNCA sai
  // do servidor (só no Coolify, igual a chave do Google). Opcionais: sem elas, mesmo
  // com a flag on, o push degrada elegante (endpoint diz enabled:false). Gerar com
  // `node -e "console.log(require('web-push').generateVAPIDKeys())"`.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  // Contato do "dono" do push (exigência do protocolo: e-mail/URL pra o serviço de
  // push falar com a gente se houver abuso). mailto: do Wallace por padrão.
  VAPID_SUBJECT: z.string().min(1).default('mailto:wallfernandes85@gmail.com'),
  // Chave do Google Maps Platform (Geocoding + Distance Matrix). Sem ela, a camada
  // força linha reta mesmo com ROUTING_GEO_ROAD_DISTANCE on (degrada elegante).
  GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  // Cache de geocode/distância (commerce.geo_cache, 0098): read-through sobre o
  // Google — geocode de bairro/endereço e distância cliente→loja repetem muito e o
  // Google cobra por chamada. FAIL-OPEN (erro de banco → chama o Google direto) e
  // NUNCA muda resultado (guarda a resposta que o Google deu). Default LIGADO —
  // exceção consciente ao "sobe dormente": não é mudança de roteamento, só de
  // custo/latência. false = sempre Google (comportamento de antes).
  GEO_CACHE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  // Trava de custo do Distance Matrix com MUITAS lojas (escala 100 borracharias):
  // mede a RUA só das K mais próximas em LINHA RETA dentro do teto (a rua nunca é
  // menor que a reta). Com ≤K lojas no teto não muda NADA (hoje: 7 lojas, neutro).
  GEO_ROAD_TOPK: z.string().transform(Number).pipe(z.number().int().min(1)).default('12'),
  AGENT_V2_POLL_INTERVAL_MS: z.string().transform(Number).pipe(z.number().int().min(1000)).default('5000'),
  // Coalescing window: segundos de pausa do cliente antes do bot responder.
  // A cada nova mensagem o timer RESETA. So responde quando o cliente para
  // de digitar por X segundos. Cobre rajadas curtas e longas. Modelo
  // Intercom/Zendesk. Evita o bot responder 3x quando o cliente solta
  // "oi", "bom dia", "tem pneu pra fan?" em sequencia.
  AGENT_V2_DEBOUNCE_SECONDS: z.string().transform(Number).pipe(z.number().int().min(0).max(60)).default('3'),
  // Agent V2: lista de conversation_id (UUID) que usam o agente unificado.
  // Use "*" para rotear todas. Vazio = V2 desligado.
  AGENT_V2_CONVERSATION_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error('Invalid environment variables:\n' + issues);
  }

  return parsed.data;
}

export const env = parseEnv();
