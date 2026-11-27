import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { archiveBlockers, getPhysicalImpact, getProductIdentity, getProductImpact,
  type CatalogEnvironment, type ProductIdentity } from './catalog-product-impact.js';
import { parseCatalogTireMeasure } from './catalog-tire-measure.js';
import { createCatalogProduct } from './queries-catalogo-create.js';

const base = z.object({product_id:z.string().uuid(),reason:z.string().trim().min(2).max(500)}).strict();
export const catalogStatusBody = base.extend({acao:z.enum(['arquivar','reativar'])});
const patch = {
  product_code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9._/-]{1,79}$/i).optional(),
  product_name: z.string().trim().min(2).max(160).optional(),
  brand:z.string().trim().min(1).max(60).optional(),
  measure:z.string().trim().min(1).max(60).optional(),
  tire_condition:z.enum(['novo','meia_vida','remold']).optional(),
};
export const catalogIdentityBody = base.extend(patch).refine(data =>
  (Object.keys(patch) as (keyof typeof patch)[]).some(key => data[key] !== undefined),
  'informe_um_campo_da_identidade');
type Action = z.infer<typeof catalogStatusBody> | z.infer<typeof catalogIdentityBody>;
type Change = 'arquivar'|'reativar'|'editar'|'substituir';

function nextIdentity(old: ProductIdentity, action: Action): {target: ProductIdentity; change: Change} {
  if ('acao' in action) return {target: old, change: action.acao};
  const measure = action.measure === undefined ? null : parseCatalogTireMeasure(action.measure);
  if (action.measure !== undefined && !measure) throw Error('catalog_measure_invalid');
  const brand = action.brand === undefined ? old.brand : canonicalCatalogBrand(action.brand);
  if (action.brand !== undefined && (!brand || brand.toLowerCase()==='sem marca')) throw Error('catalog_brand_required');
  const physical = (measure && measure.canonical !== (parseCatalogTireMeasure(old.tire_size)?.canonical ?? old.tire_size))
    || brand !== old.brand || (action.tire_condition !== undefined && action.tire_condition !== old.tire_condition);
  const size = measure?.canonical ?? old.tire_size;
  const proposedCode = action.product_code?.trim().toUpperCase() ?? old.product_code;
  const newCode = proposedCode.toLowerCase() !== old.product_code.toLowerCase();
  const target: ProductIdentity = {...old, brand, tire_size:size,
    tire_condition: action.tire_condition ?? old.tire_condition, product_code:newCode ? proposedCode : old.product_code,
    product_name:action.product_name?.trim().replace(/\s+/g,' ') ?? (physical ? `Pneu ${brand ?? ''} ${size}` : old.product_name)};
  // O código aparece em atendimentos anteriores. Reservá-lo na ficha original
  // impede que uma consulta histórica passe a resolver outro produto.
  return {target, change: physical || newCode ? 'substituir' : 'editar'};
}

export async function planCatalogProduct(db: PoolClient, env: CatalogEnvironment, data: Action) {
  const atual = await getProductIdentity(db,env,data.product_id,true);
  const { change, target } = nextIdentity(atual,data);
  if (change==='arquivar' || change==='substituir' || change==='reativar') {
    // O galpão opera por medida, sem FK para o produto. Uma contagem ou recebimento
    // concorrente deve concluir antes da leitura que entra na proposta.
    await db.query(`SELECT id FROM commerce.wholesale_stock WHERE environment=$1
      AND commerce.catalog_measure_identity(measure) IN (commerce.catalog_measure_identity($2),commerce.catalog_measure_identity($3))
      ORDER BY id FOR SHARE`,[env,atual.tire_size,target.tire_size]);
    await db.query(`SELECT id FROM commerce.partner_stock_levels WHERE environment=$1 AND product_id=$2
      AND deleted_at IS NULL ORDER BY id FOR SHARE`,[env,atual.product_id]);
    await db.query(`SELECT id FROM commerce.stock_levels WHERE environment=$1 AND product_id=$2 ORDER BY id FOR SHARE`,[env,atual.product_id]);
  }
  const impacto = await getProductImpact(db,env,atual);
  const bloqueios: string[] = [];
  if (change==='editar' || change==='substituir') {
    if (atual.archived) bloqueios.push('ficha_arquivada');
    if (change==='substituir' && target.product_code.toLowerCase()===atual.product_code.toLowerCase())
      bloqueios.push('informe_um_novo_codigo_para_preservar_o_anterior');
  }
  if ((change==='arquivar' && !atual.archived) || change==='substituir') bloqueios.push(...archiveBlockers(impacto));
  let destinoFisico;
  if (change==='substituir') {
    destinoFisico = await getPhysicalImpact(db,env,target);
    if (destinoFisico.saldo || destinoFisico.reservado || destinoFisico.em_transito)
      bloqueios.push('destino_possui_estoque_ou_compra_em_transito');
    if (!target.brand || target.brand.toLowerCase()==='sem marca') bloqueios.push('informe_a_marca_do_novo_produto');
    if (!parseCatalogTireMeasure(target.tire_size)) bloqueios.push('informe_a_medida_do_novo_produto');
  }
  if (target.product_code!==atual.product_code) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`catalog-code:${env}:${target.product_code.toLowerCase()}`]);
    if ((await db.query(`SELECT 1 FROM commerce.products WHERE environment=$1 AND id<>$2 AND lower(product_code)=lower($3)`,
      [env,atual.product_id,target.product_code])).rowCount) bloqueios.push('codigo_ja_utilizado');
  }
  if (change==='substituir' || (change==='reativar' && atual.archived)) {
    const duplicate = await db.query(`SELECT 1 FROM commerce.products p JOIN commerce.tire_specs ts
      ON p.environment=ts.environment AND p.id=ts.product_id WHERE p.environment=$1 AND p.id<>$2 AND p.deleted_at IS NULL
      AND p.product_type='tire' AND NOT p.partner_generic AND commerce.catalog_measure_identity(ts.tire_size)=commerce.catalog_measure_identity($3)
      AND commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity($4) AND p.tire_condition=$5 LIMIT 1`,
    [env,atual.product_id,target.tire_size,target.brand,target.tire_condition]);
    if (duplicate.rowCount) bloqueios.push('ja_existe_ficha_ativa_para_a_variante');
  }
  const {product_id: _id, archived: _archived, ...destino} = target;
  const copiarFichaTecnica = change==='substituir' && atual.brand===destino.brand && atual.tire_condition===destino.tire_condition
    && atual.tire_size===destino.tire_size;
  return {operacao:change, atual, destino, impacto, destino_fisico:destinoFisico, bloqueios,
    ...(change==='substituir' ? {copiar_ficha_tecnica:copiarFichaTecnica,
      efeito:'A ficha anterior conserva preços, mídias, vínculos e histórico. A nova recebe outro ID. '+
        (copiarFichaTecnica ? 'Os dados técnicos do pneu serão copiados.' : 'As especificações técnicas da nova variante exigem conferência.')} : {})};
}

export async function applyCatalogProduct(db: PoolClient, env: CatalogEnvironment, action: Action, actor: string) {
  const plan = await planCatalogProduct(db,env,action);
  if (plan.bloqueios.length) throw Error(plan.bloqueios[0]);
  const {atual,destino,operacao}=plan;
  let id=atual.product_id;
  let changed: boolean;
  if (operacao==='editar') {
    changed = atual.product_name!==destino.product_name;
    if (changed) await db.query(`UPDATE commerce.products SET product_name=$3,updated_at=clock_timestamp()
      WHERE environment=$1 AND id=$2`,[env,id,destino.product_name]);
  } else {
    const archived = operacao!=='reativar';
    changed = atual.archived!==archived;
    if (changed) await db.query(`UPDATE commerce.products SET deleted_at=CASE WHEN $3 THEN clock_timestamp() END,updated_at=clock_timestamp()
      WHERE environment=$1 AND id=$2`,[env,id,archived]);
    if (operacao==='substituir') {
      const created = await createCatalogProduct({environment:env,measure:destino.tire_size,brand:destino.brand!,
        tireCondition:destino.tire_condition,productCode:destino.product_code,productName:destino.product_name,
        vehicleType:destino.vehicle_type,inheritFitments:false,actorLabel:actor},undefined,db);
      id=created.product_id;
      if (plan.copiar_ficha_tecnica) await db.query(`UPDATE commerce.tire_specs next
        SET tread_pattern=old.tread_pattern,load_index=old.load_index,speed_rating=old.speed_rating,
          construction=old.construction,intended_use=old.intended_use,position=old.position
        FROM commerce.tire_specs old WHERE next.environment=$1 AND next.product_id=$2
        AND old.environment=next.environment AND old.product_id=$3`,[env,id,atual.product_id]);
      if (created.product_name!==destino.product_name) await db.query(`UPDATE commerce.products SET product_name=$3
        WHERE environment=$1 AND id=$2`,[env,id,destino.product_name]);
    }
  }
  const produto = await getProductIdentity(db,env,id);
  if (changed) await db.query(`INSERT INTO audit.events
    (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
    VALUES ($1,'catalog','commerce.products',$2,$3,$4,$5,$6)`,
  [env,atual.product_id,'catalog_product_'+operacao,actor,JSON.stringify(atual),
    JSON.stringify({produto,reason:action.reason,impacto:plan.impacto})]);
  return {changed,operacao,produto,...(operacao==='substituir'?{produto_arquivado:atual.product_id,efeito:plan.efeito}:{})};
}
