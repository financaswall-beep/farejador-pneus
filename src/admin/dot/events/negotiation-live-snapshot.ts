import { z } from 'zod';
import type { Pool } from 'pg';
import type { Environment } from '../../../shared/types/chatwoot.js';

const numberOrNull = z.number().nullable();
const history = z.object({
  rotas_encerradas: z.number(),
  rotas_com_despesa_aprovada: z.number(),
  total_despesas_aprovadas_centavos: numberOrNull,
  media_despesas_aprovadas_por_rota_com_registro_centavos: numberOrNull,
  rotas_com_combustivel_informado: z.number(),
  total_combustivel_informado_centavos: numberOrNull,
  media_combustivel_por_rota_com_registro_centavos: numberOrNull,
});
const routes = z.object({
  rotas_abertas: z.number(),
  entregas_pendentes: z.number(),
  aguardando_saida: z.number(),
  em_entrega: z.number(),
  entregas_sem_municipio_cadastrado: z.number(),
  entregas_com_municipio_cadastrado_igual: numberOrNull,
  rotas_com_municipio_cadastrado_igual: numberOrNull,
  praca_referencia: z.object({
    municipio: z.string(),
    fonte: z.enum(['roteamento_entrega_deste_turno','referencia_recente_da_conversa']),
  }).nullable(),
  historico_30_dias: history,
});

// z.object descarta chaves desconhecidas em cada nível. A origem é a ficha
// comercial montada pelo servidor; mensagens e argumentos do modelo ficam fora.
const negotiationSnapshot = z.object({
  medida: z.string().nullable(),
  marca: z.string().nullable(),
  condicao: z.string(),
  disponivel: numberOrNull,
  reservado: numberOrNull,
  estoque_vendavel: z.boolean(),
  motivo_estoque: z.string().nullable(),
  custo_unitario_centavos: numberOrNull,
  custo_produtos_para_quantidade_centavos: numberOrNull,
  tabela_atual_centavos: numberOrNull,
  vendas_liquidas_30_dias: numberOrNull,
  entradas_previstas: numberOrNull,
  data_reposicao_confirmada: z.string().date().nullable(),
  cobertura_estimada_dias: numberOrNull,
  rota_compativel_confirmada: z.boolean().nullable(),
  custo_incremental_entrega_centavos: numberOrNull,
  rotas: routes.nullable(),
});

export async function registrarLeituraFichaMilly(db: Pick<Pool,'query'>, environment: Environment, id: string, owner: string, facts: object) {
  // Com o código novo e o schema 0296, o atendimento segue sem histórico da ficha.
  const schema = await db.query<{instrumentado:boolean; lido_em:Date}>(`SELECT clock_timestamp() AS lido_em, EXISTS (
    SELECT FROM pg_catalog.pg_attribute WHERE attrelid='ops.milly_consultas'::regclass
      AND attname='context_snapshot' AND NOT attisdropped) AS instrumentado`);
  if (!schema.rows[0]!.instrumentado) return schema.rows[0]!.lido_em;

  const snapshot = negotiationSnapshot.parse(facts);
  const result = await db.query<{context_read_at:Date}>(`WITH gate AS (
    SELECT generation FROM ops.milly_consulta_config WHERE environment=$1 AND enabled AND owner_person_id=$3 FOR SHARE
  ) UPDATE ops.milly_consultas r SET context_read_at=clock_timestamp(), context_snapshot=$4::jsonb
    FROM gate WHERE r.environment=$1 AND r.id=$2 AND r.generation=gate.generation
      AND r.state='pending' AND r.request_deadline>clock_timestamp()
    RETURNING r.context_read_at`,[environment,id,owner,JSON.stringify(snapshot)]);
  return result.rows[0]?.context_read_at ?? null;
}
