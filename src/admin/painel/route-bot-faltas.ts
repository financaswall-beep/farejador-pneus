import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { logger } from '../../shared/logger.js';
import { getBotShortages, getBotShortageConsultations, exportBotShortages } from './queries-bot-faltas.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v+'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===v;
});
export const shortageQuery = z.object({
  from: date, to: date, store: z.union([z.literal('matriz'),z.string().uuid()]).optional(),
  measure: z.string().trim().max(80).optional(), offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict().refine(v => v.from<=v.to && v.to<=businessDateSaoPaulo(new Date())
  && (Date.parse(v.to)-Date.parse(v.from))/86400000<=365);

export function shortageCsvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export async function registerBotShortageRoutes(fastify: FastifyInstance): Promise<void> {
  for (const operation of ['faltas','faltas/consultas','faltas/exportar']) {
    fastify.get('/admin/api/bot/'+operation,{preHandler:requireAdminAuth},async (request,reply) => {
      const parsed=shortageQuery.safeParse(request.query);
      if (!parsed.success || (operation.endsWith('consultas') && !parsed.data.measure)) {
        return reply.code(400).send({error:'invalid_shortage_period_or_filter'});
      }
      reply.header('Cache-Control','no-store');
      try {
        if (operation.endsWith('exportar')) {
          const rows=await exportBotShortages(parsed.data);
          if(rows.length>10000) return reply.code(422).send({error:'export_limit_reduce_period'});
          const lines=[['Última busca do grupo','Data e hora (São Paulo)','Medida','Município','Loja sem disponibilidade','Filtros da última busca','Resultado da última busca','Buscas agrupadas (uma falta por conversa, medida e loja)'],
            ...rows.map(r=>[r.id,new Date(r.occurred_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),
              r.measure,r.municipality,r.store_name,JSON.stringify(r.filters),r.result,r.searches])];
          return reply.header('Content-Disposition',`attachment; filename="faltas-${parsed.data.from}-${parsed.data.to}.csv"`)
            .type('text/csv; charset=utf-8').send('\uFEFF'+lines.map(row=>row.map(shortageCsvCell).join(';')).join('\r\n'));
        }
        return operation.endsWith('consultas') ? await getBotShortageConsultations(parsed.data) : await getBotShortages(parsed.data);
      } catch(err) {
        logger.error({err},'bot_shortage_report_failed');
        return reply.code(503).send({error:'shortage_report_unavailable'});
      }
    });
  }
}
