import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { requireSending } from '../../marketing/publisher/config.js';
import { destinationSchema, draftSchema, PublisherError, visiblePostStatus } from '../../marketing/publisher/model.js';
import { postMediaIdsSql } from '../../marketing/publisher/post-photos.js';
import { saveDraft, submitPost, postAction } from '../../marketing/publisher/posts.js';
import { reschedulePost } from '../../marketing/publisher/reschedule.js';
import { TIRE_CONDITIONS, tireConditionLabel } from '../../shared/tire-condition.js';

const id = z.string().uuid();
const when = z.string().datetime({offset:true}).describe('Data e hora ISO com fuso. Use o horário de Brasília quando o dono não indicar outro.');
const target = z.object({post_id:id, versao:z.number().int().positive(), idempotency_key:id}).strict();
export const sendInput = target.extend({agendado_para:when.nullable().describe('null para publicar agora; data e hora para agendar')});
export const rescheduleInput = target.extend({agendado_para:when});
export const cancelInput = target;
export const readInput = z.object({
  visao:z.enum(['posts','midias']).default('posts'), post_id:id.optional(), pagina:z.number().int().min(1).max(10000).default(1),
}).strict();
const tire = z.object({medida:z.string().trim().min(2).max(40).regex(/^[0-9][0-9A-Za-z.,/ xX-]*$/),
  condicao:z.enum(TIRE_CONDITIONS), marca:z.string().trim().min(1).max(60).optional(),
  fotos:z.array(z.number().int().min(1).max(10)).min(1).max(10).optional(),
}).strict();
export const prepareInput = z.object({
  post_id:id.describe('UUID estável do rascunho. Gere um UUID para um novo post.'),
  versao:z.number().int().min(0).describe('Zero para criar; versão consultada para editar.'),
  excluir_midias_apos_publicar:z.boolean().optional().describe('Mantém a preferência anterior ao editar. Novos posts usam a preferência padrão do painel.'),
  titulo:z.string().trim().min(1).max(180), legenda:z.string().trim().min(1).max(2200),
  pneus:z.array(tire).max(12).describe('Use dados confirmados pelo dono ou catálogo. [] para conteúdo sem produto específico. Em carrossel de vários pneus, identifique todas as posições em fotos.'),
  midias:z.array(id).min(1).max(10).describe('UUIDs prontos da biblioteca, em ordem de exibição.'),
  destinos:z.array(destinationSchema.omit({caption:true})).min(1).max(2),
  idempotency_key:id,
}).strict();

export function buildPublisherDraft(data: z.infer<typeof prepareInput>) {
  const carousel = data.midias.length > 1;
  const multiple = data.pneus.length > 1;
  const used = new Set<number>();
  const lines = data.pneus.map(t => {
    if (carousel && multiple && !t.fotos) throw new PublisherError('informe_as_fotos_de_cada_pneu', 400);
    for (const pos of t.fotos ?? []) {
      if (!carousel || pos > data.midias.length || used.has(pos)) throw new PublisherError('posicao_de_foto_invalida', 400);
      used.add(pos);
    }
    const label = [t.medida, tireConditionLabel(t.condicao), t.marca].filter(Boolean).join(' · ');
    if (!t.fotos) return label;
    return (t.fotos.length === 1 ? 'Foto ' : 'Fotos ') + t.fotos.join(', ') + ': ' + label;
  });
  if (carousel && multiple && used.size !== data.midias.length) throw new PublisherError('falta_identificar_foto_do_carrossel', 400);
  const caption = [data.legenda, lines.join('\n')].filter(Boolean).join('\n\n');
  if (caption.length > 2200) throw new PublisherError('legenda_com_produtos_excede_2200', 400);
  return draftSchema.parse({version:data.versao,title:data.titulo,caption,media_id:data.midias[0],
    media_ids:data.midias,destinations:data.destinos,delete_after_publish:data.excluir_midias_apos_publicar});
}

export async function preparePost(db: PoolClient, data: z.infer<typeof prepareInput>, actor: string) {
  const draft = buildPublisherDraft(data);
  if (data.versao > 0 && data.excluir_midias_apos_publicar === undefined) {
    const prior = (await db.query('SELECT delete_after_publish FROM ops.publisher_posts WHERE environment=$1 AND id=$2 AND version=$3 FOR UPDATE',
      [env.FAREJADOR_ENV,data.post_id,data.versao])).rows[0];
    if (!prior) throw new PublisherError('publisher_version_conflict');
    draft.delete_after_publish = prior.delete_after_publish;
  }
  const post = await saveDraft(db, env.FAREJADOR_ENV, data.post_id, draft, actor);
  return {post_id:post.id,versao:post.version,status:post.status,legenda:post.caption,destinos:post.destinations,midias:post.media_ids};
}

async function verifyVersion(db: PoolClient, data: z.infer<typeof target>) {
  const row = (await db.query('SELECT version,status FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE',
    [env.FAREJADOR_ENV,data.post_id])).rows[0];
  if (!row) throw new PublisherError('publisher_post_not_found',404);
  if (row.version !== data.versao) throw new PublisherError('publisher_version_conflict');
}

export async function sendPost(db: PoolClient, data: z.infer<typeof sendInput>, actor: string) {
  requireSending();
  await verifyVersion(db, data);
  const p = await submitPost(db,env.FAREJADOR_ENV,data.post_id,data.versao,data.agendado_para,actor);
  return {post_id:p.id,versao:p.version,status:p.status,agendado_para:data.agendado_para};
}
export async function movePost(db: PoolClient, data: z.infer<typeof rescheduleInput>, actor: string) {
  requireSending();
  await verifyVersion(db,data);
  const p = await reschedulePost(db,env.FAREJADOR_ENV,data.post_id,data.versao,data.agendado_para,actor);
  return {post_id:p.id,versao:p.version,status:p.status,agendado_para:p.scheduled_at};
}
export async function cancelPost(db: PoolClient, data: z.infer<typeof cancelInput>, actor: string) {
  await verifyVersion(db,data);
  await postAction(db,env.FAREJADOR_ENV,data.post_id,'cancel',actor);
  return {post_id:data.post_id,status:'cancelled'};
}

export async function readPublisher(db: Pick<PoolClient, 'query'>, data: z.infer<typeof readInput>) {
  const offset = (data.pagina-1)*20;
  if (data.visao === 'midias') {
    if (data.post_id) throw new PublisherError('use_visao_posts_para_post_id',400);
    const rows = (await db.query(`SELECT id AS media_id,name AS nome,kind AS tipo,mime,bytes,status
      FROM ops.publisher_media WHERE environment=$1 AND status='ready' ORDER BY created_at DESC,id LIMIT 21 OFFSET $2`,
      [env.FAREJADOR_ENV,offset])).rows;
    return {midias:rows.slice(0,20),tem_mais:rows.length>20};
  }
  const rows = (await db.query(`SELECT p.id AS post_id,p.version AS versao,p.title AS titulo,p.caption AS legenda,
    p.destinations AS destinos,p.status,p.scheduled_at AS agendado_para,${postMediaIdsSql} AS midias,
    ARRAY(SELECT jsonb_build_object('rede',d.platform,'status',CASE WHEN d.removal_state='deleted' THEN 'deleted' ELSE d.status END,
      'link',d.post_url,'erro',coalesce(d.removal_error,d.error_code),'exclusao',d.removal_state)
      FROM ops.publisher_destinations d WHERE d.environment=p.environment AND d.post_id=p.id ORDER BY d.platform) AS entregas
    FROM ops.publisher_posts p WHERE p.environment=$1 AND ($2::uuid IS NULL OR p.id=$2)
    ORDER BY p.updated_at DESC,p.id LIMIT 21 OFFSET $3`,[env.FAREJADOR_ENV,data.post_id??null,offset])).rows;
  return {posts:rows.slice(0,20).map(p => ({...p,status:visiblePostStatus(p.status,p.entregas)})),tem_mais:rows.length>20};
}
