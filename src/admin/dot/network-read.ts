import { readPage, rejectFilters, type DotReadContext } from './read-model.js';

export function readDotNetwork(ctx:DotReadContext,view:'lojas'|'comissoes'|'mensalidades'|'funil') {
  rejectFilters(ctx,'medida');
  if(view==='comissoes')return readPage(ctx,`SELECT id,partner_id,partner_unit_id,partner_order_id,order_total,
    commission_percent,commission_amount,status,realized_at,settled_at FROM network.commission_entries
    WHERE environment=$1 AND (realized_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR partner_unit_id=$4) AND $5=''`,'realized_at DESC,id DESC',
  'Livro existente de comissão devida à Matriz, sem gerar cobranças ou reconciliar lançamentos.');
  if(view==='mensalidades')return readPage(ctx,`SELECT f.id,f.partner_id,f.competence,f.amount,f.due_date,f.status,f.settled_at
    FROM finance.matriz_partner_monthly_fees f WHERE f.environment=$1 AND f.competence BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR f.partner_id=$4) AND $5=''`,'competence DESC,id',
  'Mensalidades já registradas por competência, sem gerar parcelas ausentes.');
  if(view==='funil')return readPage(ctx,`SELECT pu.id,
    count(o.id) FILTER(WHERE po.id IS NOT NULL)::int requested,
    count(o.id) FILTER(WHERE po.id IS NOT NULL AND o.status='cancelled')::int cancelled,
    count(o.id) FILTER(WHERE o.status<>'cancelled' AND po.id IS NOT NULL AND po.status<>'cancelled'
      AND po.deleted_at IS NULL AND NOT po.awaiting_pickup
      AND (po.fulfillment_mode<>'delivery' OR po.delivery_status='delivered'))::int realized
    FROM network.partner_units pu LEFT JOIN commerce.orders o ON o.environment=pu.environment AND o.unit_id=pu.unit_id
      AND o.partner_order_id IS NOT NULL AND (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
    LEFT JOIN commerce.partner_orders po ON po.environment=o.environment AND po.id=o.partner_order_id AND po.source_tag='2w'
    WHERE pu.environment=$1 AND pu.deleted_at IS NULL AND ($4::uuid IS NULL OR pu.id=$4) AND $5=''
    GROUP BY pu.id`,'requested DESC,id','Pedidos originados pela Rede no período de criação; não inclui vendas próprias nem despesas privadas da loja.');
  return readPage(ctx,`SELECT pu.id,pu.display_name,pu.service_mode,pu.status,pu.delivery_radius_km,
    pu.accepts_network_orders,p.commercial_model,p.commission_percent,p.monthly_fee,
    u.slug,(SELECT jsonb_agg(c.display_name ORDER BY c.display_name) FROM network.municipality_catalog c WHERE c.active
      AND EXISTS(SELECT 1 FROM network.unit_coverage uc WHERE uc.environment=pu.environment AND uc.unit_id=pu.unit_id
        AND lower(uc.municipio)=lower(c.display_name))) coverage_municipalities
    FROM network.partner_units pu JOIN network.partners p ON p.environment=pu.environment AND p.id=pu.partner_id
    JOIN core.units u ON u.environment=pu.environment AND u.id=pu.unit_id
    WHERE pu.environment=$1 AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
      AND ($4::uuid IS NULL OR pu.id=$4) AND $5=''`,'display_name,id',
  'Cadastro comercial atual da Rede. Sem contatos, documentos, folha, despesas ou lucro privado das lojas.');
}

export function readDotApplications(ctx:DotReadContext) {
  rejectFilters(ctx,'medida');
  return readPage(ctx,`SELECT a.id,a.status,a.created_at,a.reviewed_at,a.created_partner_unit_id,
    (SELECT jsonb_agg(c.display_name ORDER BY c.display_name) FROM network.municipality_catalog c WHERE c.active
      AND strpos(lower(COALESCE(a.municipios,'')),lower(c.display_name))>0) recognized_municipalities
    FROM network.partner_applications a WHERE a.environment=$1
      AND (a.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR a.id=$4) AND $5=''`,'created_at DESC,id DESC',
  'Solicitações sem nomes, contatos, endereço ou mensagem livre do candidato. Regiões reconhecidas no catálogo de municípios.');
}
