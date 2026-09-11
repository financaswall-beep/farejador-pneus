window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFinanceiroView=function(){return{
  get rfinUnapplied(){return !!this.rfin.data&&this.rfinQuery(this.rfin.data.filters,'overview')!==this.rfinQuery(null,'overview');},
  get rfinProjected(){return this.rfin.tab==='cash'&&this.rfin.flow==='projected';},
  get rfinRows(){const d=this.rfin.data;if(!d)return[];return this.rfin.tab==='titles'?d.titles:this.rfin.tab==='cash'?(this.rfinProjected?d.projection.rows:d.cash_rows):d.result_rows;},
  get rfinVisibleRows(){return this.rfinRows.slice((this.rfin.page-1)*25,this.rfin.page*25);},
  get rfinSelected(){return this.rfinRows.find(row=>row.id===this.rfin.selected)||null;},
  get rfinAgenda(){const rows=(this.rfin.data?.agenda||[]).filter(row=>row.side===this.rfin.agendaSide);return rows.slice(0,5);},
  get rfinExpenseTop(){return(this.rfin.data?.expenses||[]).slice(0,3);},
  get rfinCashChart(){const rows=this.rfinProjected?this.rfin.data?.projection.daily||[]:this.rfin.data?.daily||[];
    const max=Math.max(1,...rows.flatMap(row=>[row.cash_in,row.cash_out]));return rows.map(row=>({...row,
      incoming:row.cash_in/max*100,outgoing:row.cash_out/max*100,label:row.day.slice(8)+'/'+row.day.slice(5,7),
      title:this.rpDate(row.day)+' · Entradas '+this.rpMoney(row.cash_in)+' · Saídas '+this.rpMoney(row.cash_out)}));},
  get rfinPeriodLabel(){return this.rfin.data?this.rpDate(this.rfin.data.filters.from)+' a '+this.rpDate(this.rfin.data.filters.to):'';},
  get rfinOrigins(){return[{id:'all',name:'Todas as origens'},...['atacado','varejo','compras','despesas','comissao','mensalidades','marketing','estoque','financeiro','outros'].map(id=>({id,name:this.rfinOrigin(id)}))];},
  rfinOrigin(value){return({atacado:'Atacado',varejo:'Varejo',compras:'Compras',despesas:'Despesas',comissao:'Rede · comissões',mensalidades:'Rede · mensalidades',marketing:'Marketing',estoque:'Estoque',financeiro:'Financeiro',outros:'Outras origens'})[value]||value;},
  rfinCategory(value){return({funcionario:'Equipe',combustivel:'Combustível',aluguel:'Aluguel',marketing:'Marketing',despesas:'Despesas',estoque:'Perdas / uso interno',energia:'Energia',agua:'Água',internet:'Internet',operacao:'Operação'})[value]||String(value||'Outras despesas').replaceAll('_',' ');},
  rfinTitleType(value){return({fiado:'Venda a prazo',varejo:'Venda do varejo',comissao:'Comissões agrupadas',mensalidade:'Mensalidade',fornecedor:'Fornecedor',despesa:'Despesa',folha:'Equipe',estorno_comissao:'Devolução de comissão',marketing:'Marketing',devolucao_fornecedor:'Devolução do fornecedor',devolucao_despesa:'Devolução de despesa',devolucao_cliente:'Devolução ao cliente'})[value]||value;},
  rfinDueLabel(row){if(!row?.due_on)return'Sem vencimento';const days=Math.round((Date.parse(row.due_on)-Date.parse(this.rfin.data.today))/86400000);
    return days<0?Math.abs(days)+' dia(s) em atraso':days===0?'Vence hoje':'Vence em '+days+' dia(s)';},
  rfinTime(value){return value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';},
  rfinSign(value){return(value>0?'+ ':'')+this.rpMoney(value);},
  rfinPercent(value){return value==null?'Sem base':Number(value).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';},
  rfinReference(row){return row?.reference||row?.source_id||'—';},
  rfinOriginAction(row){const module=['atacado','varejo'].includes(row?.origin)?'vendas':row?.origin==='compras'?'compras':'financeiro';return this.hasPanelModule(module)?'Abrir '+({vendas:'Vendas',compras:'Compras',financeiro:'Financeiro'})[module]+' →':'';},
};};
