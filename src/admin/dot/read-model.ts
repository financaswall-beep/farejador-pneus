import type { Pool } from 'pg';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { periodInput, dotPeriod } from './period.js';

export const pageInput = periodInput.extend({pagina:z.number().int().min(1).max(10000).default(1),
  referencia:z.string().uuid().optional(),medida:z.string().trim().max(30).regex(/^[\d\s/.RrXx-]*$/).default('')}).strict();
export type DotPageInput = z.infer<typeof pageInput>;
export interface DotReadContext { db:Pool; input:DotPageInput; period:ReturnType<typeof dotPeriod>; params:unknown[] }
export function readContext(db:Pool,input:DotPageInput):DotReadContext {
  const period=dotPeriod(input);
  return {db,input,period,params:[env.FAREJADOR_ENV,period.from,period.to,input.referencia??null,input.medida]};
}

/** Only repository-owned SELECT fragments reach this function. No model-supplied SQL. */
export async function readPage(ctx:DotReadContext,select:string,order:string,warning?:string) {
  const result=await ctx.db.query(`WITH arguments AS (SELECT $2::date,$3::date,$4::uuid,$5::text), filtered AS (${select}), selected AS (
    SELECT * FROM filtered ORDER BY ${order} LIMIT 50 OFFSET $6
  ) SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(selected ORDER BY ${order}) FROM selected),'[]'::jsonb),
    'total',(SELECT count(*) FROM filtered),'page',$7::int,'page_size',50,
    'truncated',(SELECT count(*) FROM filtered)>$6+50) AS payload`,
    [...ctx.params,(ctx.input.pagina-1)*50,ctx.input.pagina]);
  return {period:ctx.period,monetary_unit:'BRL',...result.rows[0].payload,...(warning?{warning}:{})};
}

export function project(row:unknown,fields:readonly string[]):Record<string,unknown> {
  const source=row as Record<string,unknown>;
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]));
}
export function pageRows(rows:unknown[],page:number) {
  const offset=(page-1)*50;
  return {rows:rows.slice(offset,offset+50),total:rows.length,page,page_size:50,truncated:rows.length>offset+50};
}
export function rejectFilters(ctx:DotReadContext,...fields:('medida'|'referencia')[]) {
  if(fields.some(field=>Boolean(ctx.input[field])))throw new Error('unsupported_filter_for_view');
}
