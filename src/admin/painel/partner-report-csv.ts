import type { buildPartnerReport } from './queries-partner-report.js';
import { salesReportCsvCell } from './route-sales-report.js';
const value=(n:number|null)=>n===null?'':n.toFixed(2).replace('.',',');
const status:Record<string,string>={open:'Em aberto',settled:'Recebida',reversed:'Estornada',active:'Ativo',suspended:'Suspenso',credentialing:'Credenciamento',archived:'Arquivado'};
export function partnerReportCsv(r:ReturnType<typeof buildPartnerReport>){let head:string[],rows:unknown[][];
  if(r.filters.view==='sales'){
    head=['Pedido','Data realizada','Parceiro','Loja','Origem','Modalidade','Itens','Total','Frete incluído','Comissão registrada'];
    rows=r.sales.map(s=>[s.id,s.day,s.partner_name,s.unit_name,s.channel==='farejador'?'Farejador':s.channel==='direct'?'Venda direta':'Outra origem',s.mode,s.quantity,value(s.total),value(s.freight),value(s.commission)]);
  }else if(r.filters.view==='commissions'){
    head=['Comissão','Parceiro','Loja','Pedido','Gerada em','Base sem frete','Percentual registrado','Comissão','Situação atual','Recebida em','Estornada em','Devolução','Valor da devolução','Devolvida em'];
    rows=r.commissions.map(c=>[c.id,c.partner_name,c.unit_name,c.order_id,c.day,value(c.base),value(c.percent),value(c.amount),status[c.status],c.settled_on,c.reversed_on,c.refund_status==='pending'?'Pendente':c.refund_status==='paid'?'Devolvida':'Não devida',value(c.refund_amount),c.refunded_on]);
  }else{
    head=['Parceiro','Municípios das lojas','Situação','Lojas','Vendas','Pedidos','Vendas comparação','Variação %','Ticket médio','Pelo Farejador','Vendas diretas','Outras origens','Comissões geradas','Recebidas destas até hoje','Estornadas destas até hoje','A receber agora','A devolver agora'];
    rows=r.partners.map(p=>[p.name,p.city,status[p.status]||p.status,p.units.length,value(p.sales),p.orders,value(p.previous),value(p.delta),value(p.ticket),value(p.farejador),value(p.direct),value(p.other),value(p.generated),value(p.cohort_received),value(p.cohort_reversed),value(p.open),value(p.refund)]);
  }
  return'\uFEFF'+[head,...rows].map(row=>row.map(salesReportCsvCell).join(';')).join('\r\n');
}
