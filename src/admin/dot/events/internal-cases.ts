import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { env } from '../../../shared/config/env.js';
import { DOT_SCOPE } from '../config.js';
import { lockGrant, transact } from '../installment-reviews.js';
import { withDotReadOnly } from '../read-only.js';
import type { DotIdentity } from '../token-store.js';
import { readSettings, ruleEnabled } from './settings.js';

const categories=z.enum(['priorizar_atendimento','revisar_bot','rascunhar_retorno','investigar_perda',
  'sugerir_transferencia','conferir_estoque','priorizar_classificacao','rascunhar_cotacao',
  'revisar_legenda','rascunhar_post','avaliar_campanha','sugerir_oferta','conferir_pendencia']);
const register=z.object({evento:z.string().regex(/^evt_[a-f0-9]{64}$/),tipo:categories,
  resumo:z.string().trim().min(1).max(2000),prioridade:z.enum(['normal','alta']).default('normal')}).strict();
const list=z.object({situacao:z.enum(['abertas','encerradas']).default('abertas'),
  tipo:categories.optional(),pagina:z.number().int().min(1).max(10000).default(1)}).strict();
const close=z.object({pendencia:z.string().uuid(),evento_esperado:register.shape.evento}).strict();
function definition(name:string,description:string,schema:z.ZodTypeAny,readOnlyHint:boolean):Tool & {securitySchemes:{type:string;scopes:string[]}[]} {
  const {$schema,...json}=zodToJsonSchema(schema,{$refStrategy:'none'});
  const securitySchemes=[{type:'oauth2',scopes:[DOT_SCOPE]}];
  return {name,description,inputSchema:json as Tool['inputSchema'],securitySchemes,_meta:{securitySchemes},
    annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
}
export const caseTools=[
  definition('registrar_pendencia_interna','Guarda uma tarefa, análise ou rascunho privado do dono a partir do eventId recebido. Reutiliza o caso por origem e tipo. Resuma a evidência e o próximo passo sem dados pessoais. Avise o dono quando alterada=true e a ação for relevante.',register,false),
  definition('consultar_pendencias_internas','Pendências e rascunhos privados do dono, com origem e versão do evento. Até 50 por página.',list,true),
  definition('encerrar_pendencia_interna','Encerra apenas a pendência interna identificada após verificar que foi resolvida. Use o evento atual retornado pela consulta.',close,false),
];
const columns='id,entity_id AS origem,event_name AS fonte,event_id AS evento,category AS tipo,summary AS resumo,priority AS prioridade,closed_at AS encerrada_em,updated_at AS atualizada_em';
export async function invokeCaseTool(identity:DotIdentity,name:string,args:unknown) {
  const scope=[env.FAREJADOR_ENV,identity.person_id];
  try {
    let result;
    if(name==='consultar_pendencias_internas'){
      const data=list.parse(args??{});
      const rows=await withDotReadOnly(async db=>(await db.query(`SELECT ${columns} FROM ops.dot_internal_cases
        WHERE environment=$1 AND person_id=$2 AND (closed_at IS NULL)=$3 AND ($4::text IS NULL OR category=$4)
        ORDER BY (priority='alta') DESC,updated_at DESC,id LIMIT 51 OFFSET $5`,
      [...scope,data.situacao==='abertas',data.tipo??null,(data.pagina-1)*50])).rows);
      result={pendencias:rows.slice(0,50),tem_mais:rows.length>50};
    } else result=await transact(async db=>{
      const grant=await lockGrant(db,identity.person_id,identity.grant_id);
      if(!grant.monitor_owner_approval) throw new McpError(ErrorCode.InvalidRequest,'Ative o acompanhamento nesta conexão.');
      if(name==='encerrar_pendencia_interna'){
        const data=close.parse(args);
        const row=(await db.query(`SELECT event_id,closed_at FROM ops.dot_internal_cases
          WHERE environment=$1 AND person_id=$2 AND id=$3 FOR UPDATE`,[...scope,data.pendencia])).rows[0];
        if(!row || row.event_id!==data.evento_esperado) throw new McpError(ErrorCode.InvalidParams,'Consulte a versão atual da pendência.');
        if(!row.closed_at) await db.query(`UPDATE ops.dot_internal_cases SET closed_at=now(),updated_at=now()
          WHERE environment=$1 AND person_id=$2 AND id=$3`,[...scope,data.pendencia]);
        return {id:data.pendencia,encerrada:true,alterada:!row.closed_at};
      }
      const data=register.parse(args);
      const event=(await db.query(`SELECT s.event_name,d.entity_id,d.created_at FROM ops.dot_event_deliveries d
        JOIN network.dot_event_subscriptions s ON s.environment=d.environment AND s.id=d.subscription_id AND s.activation_id=d.activation_id
        WHERE d.environment=$1 AND s.person_id=$2 AND s.grant_id=$3 AND d.id=$4 AND d.status IN ('sent','pending')
          AND s.revoked_at IS NULL AND s.expires_at>now()`,[...scope,identity.grant_id,data.evento])).rows[0];
      if(!event || !ruleEnabled((await readSettings(db)).settings,event.event_name))
        throw new McpError(ErrorCode.InvalidParams,'Evento indisponível para este acompanhamento.');
      const key=[...scope,event.entity_id,data.tipo];
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key.join(':')]);
      const current=(await db.query(`SELECT id,summary,priority,closed_at,
        (event_id=$5 OR event_created_at > $6 OR closed_at >= $6) AS ja_processado
        FROM ops.dot_internal_cases WHERE environment=$1 AND person_id=$2 AND entity_id=$3 AND category=$4 FOR UPDATE`,
      [...key,data.evento,event.created_at])).rows[0];
      if(current?.ja_processado) return {id:current.id,alterada:false};
      const row=(await db.query(`INSERT INTO ops.dot_internal_cases
        (environment,person_id,entity_id,category,event_name,event_id,event_created_at,summary,priority)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(environment,person_id,entity_id,category) DO UPDATE SET
          event_name=excluded.event_name,event_id=excluded.event_id,event_created_at=excluded.event_created_at,
          summary=excluded.summary,priority=excluded.priority,closed_at=NULL,updated_at=now() RETURNING id`,
      [...key,event.event_name,data.evento,event.created_at,data.resumo,data.prioridade])).rows[0];
      return {id:row.id,alterada:!current || !!current.closed_at || current.summary!==data.resumo || current.priority!==data.prioridade};
    });
    return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
  } catch(error) {
    if(error instanceof McpError) throw error;
    if(error instanceof z.ZodError) throw new McpError(ErrorCode.InvalidParams,'Confira os campos da pendência.');
    throw new McpError(ErrorCode.InternalError,'Pendências internas indisponíveis.');
  }
}
