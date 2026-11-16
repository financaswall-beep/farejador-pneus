import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { bounded,signal } from './signal-model.js';
import type { DotSettings } from './settings.js';

export async function draftSignals(db:Pool,_settings:DotSettings,now:Date) {
  const rows=await db.query(`SELECT id,version,updated_at FROM ops.publisher_posts
    WHERE environment=$1 AND status='draft' AND updated_at BETWEEN $2::timestamptz-interval '1 day' AND $2
    ORDER BY updated_at DESC,id LIMIT 1001`,[env.FAREJADOR_ENV,now]);
  return bounded(rows.rows).map(row=>signal('farejador.marketing.rascunho',row.id,'rascunho_para_revisao',
    'ops.publisher_posts',{post_id:row.id,version:row.version},row.updated_at,[row.version]));
}

export async function lotSignals(db:Pool,_settings:DotSettings,now:Date) {
  const rows=await db.query(`SELECT l.id,l.lot_number,l.quantity_on_hand-l.quantity_reserved AS disponivel,
      max(m.created_at) AS changed_at FROM commerce.tire_lot_movements m
    JOIN commerce.tire_lots l ON l.environment=m.environment AND l.id=m.lot_id
    WHERE m.environment=$1 AND m.created_at BETWEEN $2::timestamptz-interval '1 day' AND $2
      AND l.quantity_on_hand>l.quantity_reserved GROUP BY l.id
    ORDER BY max(m.created_at) DESC,l.id LIMIT 1001`,[env.FAREJADOR_ENV,now]);
  return bounded(rows.rows).map(row=>signal('farejador.estoque.lote',row.id,'lote_com_saldo_para_conferencia',
    'commerce.tire_lots',{lot_id:row.id,lot_number:row.lot_number,unidades_livres:row.disponivel},row.changed_at,[row.disponivel,row.changed_at]));
}
