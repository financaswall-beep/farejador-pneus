import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { clienteAceitouDepois } from './milly-checkout.js';
import { reconciliarPublicacaoMilly } from './milly-negociacao.js';
import { loadCurrentCatalogPrices } from '../shared/catalog-pricing.js';
import { money } from './milly-termos.js';

interface Cotacao {
  loja:string; itens:{product_id:string;quantidade:number;preco_unitario:number}[];
  frete:number; pagamento:string|null; modalidade:string; endereco:string|null;
}
export async function reconfirmarAposVencimento(client:PoolClient,environment:Environment,conversationId:string,
  requestId:string|null,cotacao:Cotacao,usarCatalogoMatriz=false) {
  const schema=await client.query("SELECT to_regclass('ops.milly_consultas') IS NOT NULL AS pronta");
  if(schema.rows[0]?.pronta!==true)return null;
  const ids=cotacao.itens.map(i=>i.product_id);
  const vencidas=()=>client.query<{state:string;provider:string|null;vencimento:Date}>(`SELECT state,
    published_provider_id::text AS provider,valid_until AS vencimento FROM ops.milly_consultas
    WHERE environment=$1 AND conversation_id=$2 AND product_id=ANY($3::uuid[])
      AND state IN ('sending','published') AND valid_until<=clock_timestamp()`,[environment,conversationId,ids]);
  let rows=(await vencidas()).rows;
  if(rows.some(r=>r.state==='sending')){
    await reconciliarPublicacaoMilly(client,environment,conversationId);
    rows=(await vencidas()).rows;
  }
  const publicadas=rows.filter(r=>r.state==='published' && r.provider!==null);
  if(!publicadas.length)return null;
  const {pagamento,modalidade,frete,endereco}=cotacao;
  if(pagamento!=='pix' && pagamento!=='dinheiro' && pagamento!=='cartao')return {
    erro:'confirmar_pagamento',mensagem:'Confirme a forma de pagamento para apresentar o preço atualizado.'};
  if(modalidade!=='pickup' && modalidade!=='delivery')return {erro:'confirmar_modalidade'};
  const nomes=await client.query<{id:string;product_name:string}>(
    'SELECT id,product_name FROM commerce.products WHERE environment=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL',[environment,ids]);
  const porId=new Map(nomes.rows.map(p=>[p.id,p.product_name]));
  if(ids.some(id=>!porId.get(id)))return {erro:'produto_indisponivel'};
  let itens=[...cotacao.itens].sort((a,b)=>a.product_id.localeCompare(b.product_id));
  if(usarCatalogoMatriz){
    const precos=await loadCurrentCatalogPrices(client,environment,ids);
    if(ids.some(id=>!precos.has(id)))return {erro:'catalog_price_missing',mensagem:'Confira o preço do produto antes de cotar.'};
    itens=itens.map(i=>({...i,preco_unitario:precos.get(i.product_id)!.price_amount}));
  }
  const lista=itens.map(i=>`${i.quantidade} un. de ${porId.get(i.product_id)} a ${money(Math.round(i.preco_unitario*100))} cada`).join(', ');
  const total=itens.reduce((s,i)=>s+i.quantidade*Math.round(i.preco_unitario*100),Math.round(frete*100));
  const lugar=modalidade==='pickup'?`para retirada na loja ${cotacao.loja}`:
    `com entrega por ${cotacao.loja} em ${endereco} (frete de ${money(Math.round(frete*100))})`;
  const forma={pix:'no Pix',dinheiro:'em dinheiro',cartao:'no cartão'}[pagamento];
  const texto=`A condição anterior venceu. Hoje, ${lista}, ${lugar}, fica em ${money(total)} no total, ${forma}. Posso fechar por esse valor?`;
  const ultimoProvider=publicadas.reduce((max,r)=>BigInt(r.provider!)>max?BigInt(r.provider!):max,0n).toString();
  const vencimento=new Date(Math.max(...publicadas.map(r=>r.vencimento.getTime())));
  // Só conta a nova cotação pública com a cesta, loja, modalidade, frete e preço atuais.
  // Um rascunho, uma nota interna ou uma cotação anterior ao vencimento não dão aceite.
  const prova=await client.query<{id:string}>(`SELECT id::text FROM (
    SELECT chatwoot_message_id AS id FROM core.messages
      WHERE environment=$1 AND conversation_id=$2 AND message_type=1 AND sender_type IN ('user','agent_bot')
      AND NOT is_private AND deleted_at IS NULL AND content=$3 AND sent_at>=$4 AND chatwoot_message_id>$5::bigint
    UNION ALL SELECT provider_message_id FROM ops.outbound_messages WHERE environment=$1 AND conversation_id=$2
      AND kind='agent_text' AND body=$3 AND status IN ('sent_api_ack','delivered')
      AND COALESCE(sent_at,updated_at)>=$4 AND provider_message_id>$5::bigint
    ) p ORDER BY p.id DESC LIMIT 1`,[environment,conversationId,texto,vencimento,ultimoProvider]);
  const publicada=prova.rows[0];
  if(publicada && await clienteAceitouDepois(client,environment,conversationId,requestId,publicada.id,{
    approvedTotalCents:total,quantity:itens.reduce((s,i)=>s+i.quantidade,0),paymentMethod:pagamento,fulfillmentMode:modalidade
  }))return null;
  return {erro:'oferta_expirada',texto_para_cliente:texto};
}
