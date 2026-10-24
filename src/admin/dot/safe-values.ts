/** Payment labels are free text in legacy tables. Never return the original value. */
export function paymentMethodSql(column:'o.payment_method'|'p.payment_method') {
  return `CASE lower(trim(${column})) WHEN 'pix' THEN 'pix' WHEN 'dinheiro' THEN 'dinheiro'
    WHEN 'cash' THEN 'dinheiro' WHEN 'cartão' THEN 'cartao' WHEN 'cartao' THEN 'cartao'
    WHEN 'credit_card' THEN 'cartao_credito' WHEN 'credito' THEN 'cartao_credito'
    WHEN 'debit_card' THEN 'cartao_debito' WHEN 'debito' THEN 'cartao_debito'
    WHEN 'transferencia' THEN 'transferencia' WHEN 'transferência' THEN 'transferencia'
    WHEN 'fiado' THEN 'fiado' WHEN 'a receber' THEN 'fiado' ELSE NULL END`;
}
export const classificationValueSql=`CASE WHEN cc.value IN (
  'purchase_intent','quote_sent','won','lost','competitor','price','saudacao','identificacao','medida_identificada',
  'preco_cotado','intencao_compra','pedido_criado','entregue','retirado','sem_estoque','sem_cobertura',
  'abandonou','escalado','nao_resolvido','desconhecido','fechou','cancelado','escalou','desistiu_cedo',
  'frete_calculado','forneceu_bairro','recebeu_cotacao','mostrou_interesse','abriu_conversa','nao_se_aplica',
  'pedido_cancelado','escalado_humano','objecao_preco','mencionou_concorrente','desistiu_apos_frete',
  'desistiu_apos_bairro','abandonou_sem_motivo_claro','outros') THEN cc.value ELSE 'outros' END`;
export const measurePattern='^([0-9]{2,3}/[0-9]{2,3}[-Rr][0-9]{2}|[0-9]{1,2}[.][0-9]{1,2}-[0-9]{2}|[0-9]{3}[Rr][0-9]{2})$';
