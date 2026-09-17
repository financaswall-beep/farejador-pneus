import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Environment } from '../shared/types/chatwoot.js';
import { loadCurrentCatalogPrices } from '../shared/catalog-pricing.js';
import { buildMatrizStockIndex,matrizStockForMeasure } from '../shared/matriz-stock-source.js';
import { loadMatrizOfficialStock,loadMatrizProductStockSpecs } from './matriz-stock-variants.js';
import { planMatrizReservationEdit,applyMatrizReservationEdit } from './matriz-stock-reservation.js';
import { amountCents,loadEditableOrder,orderEditFingerprint,latestOrderEditMessages } from './order-edit-state.js';
import { quoteOrderDeliveryChange,quoteOrderPickupChange } from './order-edit-delivery.js';

const orderNumber=z.string().trim().min(1).max(40).transform(s=>s.toUpperCase());
const previewInput=z.object({
  order_number:orderNumber,
  itens_finais:z.array(z.object({product_id:z.string().uuid(),quantidade:z.number().int().positive().max(1000)}).strict()).min(1).max(30).optional(),
  novo_endereco:z.string().trim().min(8).max(350).optional(),
  nova_modalidade:z.enum(['pickup','delivery']).optional(),
  nova_forma_pagamento:z.enum(['pix','cartao','dinheiro']).optional(),
  motivo:z.string().trim().max(300).optional(),
}).strict().refine(v=>v.itens_finais||v.novo_endereco||v.nova_forma_pagamento||v.nova_modalidade);
const confirmInput=z.object({order_number:orderNumber,confirmar_alteracao_id:z.string().uuid()}).strict();
type EditInput=z.infer<typeof previewInput>;
type State=Awaited<ReturnType<typeof loadEditableOrder>>;
interface ProposedItem { product_id:string;produto:string;quantidade:number;preco_unitario:string;custo_unitario:string|null }
interface Proposal {
  order_number:string;modalidade:string;endereco_entrega:string|null;forma_pagamento:string|null;
  subtotal_itens:string;valor_frete:string;total:string;itens:ProposedItem[];
  retirada?:Awaited<ReturnType<typeof quoteOrderPickupChange>>;
}
interface Quote {
  conversation_id:string;fingerprint:string;input:EditInput;proposal:Proposal;
  source_message_id:string;source_chatwoot_message_id:string;expires_at:string;
}
const money=(cents:number)=>(cents/100).toFixed(2);
const publicProposal=(p:Proposal)=>({...p,itens:p.itens.map(({custo_unitario:_,...item})=>item)});

async function prepare(client:PoolClient,environment:Environment,state:State,input:EditInput) {
  const {order,items}=state;
  const desired=input.itens_finais??items.map(i=>({product_id:i.product_id,quantidade:i.quantity}));
  if(new Set(desired.map(i=>i.product_id)).size!==desired.length)throw Error('Informe cada produto uma vez, com a quantidade final.');
  const mode=input.nova_modalidade??order.fulfillment_mode;
  if(input.novo_endereco&&mode!=='delivery')throw Error('Endereço de entrega só pode ser informado com modalidade delivery. Pedido mantido.');
  if(mode==='delivery'&&mode!==order.fulfillment_mode&&!input.novo_endereco) {
    throw Error('Informe o endereço completo com rua, número e município para mudar para entrega.');
  }
  const products=(await client.query<{id:string;product_name:string;product_type:string;deleted_at:Date|null}>(
    `SELECT id,product_name,product_type,deleted_at FROM commerce.products
      WHERE environment=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR KEY SHARE`,[environment,desired.map(i=>i.product_id)])).rows;
  if(products.length!==desired.length||products.some(p=>p.product_type!=='tire'||p.deleted_at))throw Error('Pneu indisponível no catálogo; pedido mantido.');
  const prices=await loadCurrentCatalogPrices(client,environment,desired.filter(i=>!items.some(old=>old.product_id===i.product_id)).map(i=>i.product_id));
  const oldSubtotal=items.reduce((s,i)=>s+amountCents(i.unit_price)*i.quantity,0);
  let freight=amountCents(order.total_amount)-oldSubtotal;
  if(freight<0||(order.fulfillment_mode==='pickup'&&freight!==0))throw Error('Pedido com ajuste de preço: encaminhe ao humano.');
  const address=mode==='pickup'?null:input.novo_endereco??order.delivery_address;
  let retirada:Proposal['retirada'];
  if(mode!==order.fulfillment_mode&&mode==='pickup') {
    retirada=await quoteOrderPickupChange(client,environment);
    freight=0;
  }
  if(mode==='delivery'&&(input.novo_endereco||mode!==order.fulfillment_mode)) {
    if(!address)throw Error('Informe o endereço completo com rua, número e município para mudar para entrega.');
    freight=amountCents((await quoteOrderDeliveryChange(client,environment,address)).freight);
  }
  const reservation=await planMatrizReservationEdit(client,environment,order.id,
    items.map(i=>({productId:i.product_id,quantity:i.quantity})),desired.map(i=>({productId:i.product_id,quantity:i.quantidade})));
  const specs=await loadMatrizProductStockSpecs(client,environment,desired.map(i=>i.product_id));
  const stocks=buildMatrizStockIndex(await loadMatrizOfficialStock(client,environment));
  const proposedItems:ProposedItem[]=desired.map(i=>{
    const old=items.find(row=>row.product_id===i.product_id);
    const price=old?.unit_price??prices.get(i.product_id)?.price_amount;
    if(price==null||amountCents(price)<=0)throw Error('Pneu sem preço válido no catálogo; pedido mantido.');
    const proposed={product_id:i.product_id,produto:products.find(p=>p.id===i.product_id)!.product_name,
      quantidade:i.quantidade,preco_unitario:money(amountCents(price))};
    // Modalidade, endereço ou pagamento não recalculam o custo de itens intactos.
    // Pedidos sem snapshot continuam sem snapshot, sem inventar custo histórico.
    if(old&&old.quantity===i.quantidade)return {...proposed,custo_unitario:old.matriz_unit_cost};
    const spec=specs.find(row=>row.product_id===i.product_id)!;
    const cost=matrizStockForMeasure(stocks,spec.tire_size,spec.brand,spec.tire_condition).unit_cost;
    if(cost==null||cost<=0)throw Error('Pneu sem custo registrado; encaminhe ao humano.');
    if(old&&old.matriz_unit_cost==null)throw Error('Pedido sem custo registrado; encaminhe ao humano.');
    // Preserva custo das unidades já reservadas; novas unidades usam custo vigente.
    const newCost=old?i.quantidade<=old.quantity?Number(old.matriz_unit_cost)
      :(Number(old.matriz_unit_cost)*old.quantity+cost*(i.quantidade-old.quantity))/i.quantidade:cost;
    return {...proposed,custo_unitario:newCost.toFixed(6)};
  }).sort((a,b)=>a.product_id.localeCompare(b.product_id));
  const subtotal=proposedItems.reduce((s,i)=>s+amountCents(i.preco_unitario)*i.quantidade,0);
  const proposal:Proposal={order_number:order.order_number,modalidade:mode,
    endereco_entrega:address,forma_pagamento:input.nova_forma_pagamento??order.payment_method,
    subtotal_itens:money(subtotal),valor_frete:money(freight),total:money(subtotal+freight),itens:proposedItems,
    ...(retirada?{retirada}:{})};
  return {proposal,reservation};
}

/** Duas etapas na mesma ferramenta. A prévia só grava auditoria; a confirmação
 * revalida pedido, preço, cobertura e estoque e grava tudo numa transação. */
export async function editOpenOrder(client:PoolClient,environment:Environment,conversationId:string,args:Record<string,unknown>) {
  const confirming=args.confirmar_alteracao_id!==undefined;
  const parsed=confirming?confirmInput.safeParse(args):previewInput.safeParse(args);
  if(!parsed.success)return {erro:'Informe a alteração para cotar ou apenas pedido e confirmar_alteracao_id para confirmar. Quantidades devem ser inteiras e positivas.'};
  await client.query('BEGIN');
  try {
    const state=await loadEditableOrder(client,environment,conversationId,parsed.data.order_number);
    const {order,items}=state;
    let input:EditInput;
    let quoted:Quote|undefined;
    let quoteId:string|undefined;
    if(confirming) {
      quoteId=(parsed.data as z.infer<typeof confirmInput>).confirmar_alteracao_id;
      const row=(await client.query<{payload_after:Quote;created_at:Date}>(
        `SELECT payload_after,created_at FROM audit.events WHERE environment=$1 AND entity_id=$2
         AND event_type='bot_order_edit_quoted' AND id=$3 AND payload_after->>'conversation_id'=$4`,
        [environment,order.id,quoteId,conversationId])).rows[0];
      if(!row)throw Error('Prévia não encontrada para este pedido e conversa. Consulte e cote novamente.');
      quoted=row.payload_after;
      const applied=await client.query(`SELECT 1 FROM audit.events WHERE environment=$1 AND entity_id=$2
        AND event_type='bot_order_edit_applied' AND payload_after->>'quote_id'=$3`,[environment,order.id,quoteId]);
      if(applied.rows.length) {
        await client.query('COMMIT');
        return {ok:true,sem_alteracao:true,mensagem:'Esta alteração já foi aplicada. Consulte o pedido para seu estado atual.'};
      }
      if(Date.now()>Date.parse(quoted.expires_at))throw Error('Prévia vencida. Consulte e cote novamente antes de confirmar.');
      if(orderEditFingerprint(order,items)!==quoted.fingerprint)throw Error('Pedido mudou desde a prévia. Consulte e cote novamente.');
      const latest=(await client.query<{id:string}>(`SELECT id FROM audit.events
        WHERE environment=$1 AND entity_id=$2 AND event_type='bot_order_edit_quoted'
          AND payload_after->>'conversation_id'=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,[environment,order.id,conversationId])).rows[0];
      if(latest?.id!==quoteId)throw Error('Use a última prévia apresentada ao cliente.');
      const messages=await latestOrderEditMessages(client,environment,conversationId);
      if(messages[0]?.sender_type!=='contact'||messages[0].id===quoted.source_message_id
        ||!['user','agent_bot'].includes(messages[1]?.sender_type??'')
        ||BigInt(messages[1]!.chatwoot_message_id)<=BigInt(quoted.source_chatwoot_message_id)
        ||new Date(messages[1]!.sent_at).getTime()<Math.floor(new Date(row.created_at).getTime()/1000)*1000) {
        throw Error('Apresente a prévia e aguarde uma nova resposta do cliente antes de confirmar.');
      }
      input=previewInput.parse(quoted.input);
    } else input=parsed.data as EditInput;
    const prepared=await prepare(client,environment,state,input);
    const {proposal}=prepared;
    if(!confirming) {
      const messages=await latestOrderEditMessages(client,environment,conversationId);
      if(messages[0]?.sender_type!=='contact')throw Error('Aguarde o pedido de alteração do cliente.');
      const quote:Quote={conversation_id:conversationId,fingerprint:orderEditFingerprint(order,items),input,proposal,
        source_message_id:messages[0].id,source_chatwoot_message_id:messages[0].chatwoot_message_id,
        expires_at:new Date(Date.now()+10*60_000).toISOString()};
      const saved=await client.query<{id:string}>(`INSERT INTO audit.events
        (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after,created_at)
        VALUES($1,'orders','commerce.orders',$2,'bot_order_edit_quoted','agent_v2_bot',$3::jsonb,clock_timestamp()) RETURNING id`,
        [environment,order.id,JSON.stringify(quote)]);
      await client.query('COMMIT');
      return {previa:true,alterado:false,precisa_confirmacao:true,alteracao_id:saved.rows[0]!.id,
        total_anterior:order.total_amount,...publicProposal(proposal),
        mensagem:'Pedido original mantido. Apresente modalidade, itens, endereço, frete e total propostos; aguarde a confirmação antes de usar confirmar_alteracao_id.'};
    }
    if(!isDeepStrictEqual(publicProposal(proposal),publicProposal(quoted!.proposal))) {
      throw Error('Preço ou frete mudou, ou os dados de retirada foram atualizados. Cote novamente e peça confirmação. Pedido mantido.');
    }
    await applyMatrizReservationEdit(client,environment,order.id,prepared.reservation);
    const ids=proposal.itens.map(i=>i.product_id);
    await client.query(`DELETE FROM commerce.order_items WHERE environment=$1 AND order_id=$2 AND NOT(product_id=ANY($3::uuid[]))`,[environment,order.id,ids]);
    for(const item of proposal.itens) {
      const old=items.find(i=>i.product_id===item.product_id);
      if(old) {
        if(old.quantity!==item.quantidade)await client.query(`UPDATE commerce.order_items SET quantity=$3,matriz_unit_cost=$4 WHERE environment=$1 AND id=$2`,
          [environment,old.id,item.quantidade,item.custo_unitario]);
      }
      else await client.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,matriz_unit_cost)
        VALUES($1,$2,$3,$4,$5,$6)`,[environment,order.id,item.product_id,item.quantidade,item.preco_unitario,item.custo_unitario]);
    }
    // Uma nova entrega segue o padrão operacional D+1 a partir da troca,
    // sem herdar agendamento antigo nem retroagir à criação da retirada.
    await client.query(`UPDATE commerce.orders SET total_amount=$3,delivery_address=$4,payment_method=$5,
      geo_resolution_id=CASE WHEN delivery_address IS DISTINCT FROM $4 OR fulfillment_mode<>$6 THEN NULL ELSE geo_resolution_id END,
      scheduled_delivery_date=CASE WHEN fulfillment_mode<>$6 THEN
        CASE WHEN $6='delivery' THEN (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+1 ELSE NULL END
        ELSE scheduled_delivery_date END,
      fulfillment_mode=$6,updated_at=clock_timestamp()
      WHERE environment=$1 AND id=$2`,[environment,order.id,proposal.total,proposal.endereco_entrega,proposal.forma_pagamento,proposal.modalidade]);
    await client.query(`INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
      VALUES($1,'orders','commerce.orders',$2,'bot_order_edit_applied','agent_v2_bot',$3::jsonb,$4::jsonb)`,
      [environment,order.id,JSON.stringify(state),JSON.stringify({quote_id:quoteId,conversation_id:conversationId,proposal})]);
    await client.query('COMMIT');
    return {ok:true,...publicProposal(proposal),mensagem:'Pedido atualizado; total e reservas ajustados juntos.'};
  } catch(error) {
    await client.query('ROLLBACK');
    const message=error instanceof Error?error.message:'Falha ao editar pedido.';
    return {erro:message,alterado:false,mensagem:'Pedido original mantido. Não confirme uma alteração que falhou.',
      ...(message.includes('stock_')?{estoque_insuficiente:true,orientacao:'Consulte a disponibilidade e ofereça outra quantidade ou produto.'}:{})};
  }
}
