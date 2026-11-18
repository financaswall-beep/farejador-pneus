(function () {
  'use strict';
  const C=window.FarejadorBotChat||window.Caixa, ch=C.chat, esc=ch.escape;
  const moneyFmt=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
  const numFmt=new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1});
  const timeFmt=new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'America/Sao_Paulo'});
  const dayFmt=new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'America/Sao_Paulo'});
  const paths={lock:'M6 10h12v10H6z M8.5 10V7a3.5 3.5 0 0 1 7 0v3',clock:'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0',chevron:'m9 5 7 7-7 7',check:'m5 12 5 5 9-11',tire:'M17 3c4 1 5 6 3 11s-6 8-10 7l-4-1c-4-1-5-6-3-11S9 1 13 2z M17 3c-4-1-8 2-10 7s-1 10 3 11 M17 8c2 1 2 3 1 5s-2 4-4 4-2-3-1-5 2-4 4-4z',order:'M5 3h14v18l-3-2-4 2-4-2-3 2z M8 8h8 M8 12h6',arrow:'M6 18 18 6 M8 6h10v10'};
  const symbol=name=>'<svg class="mh-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="'+(paths[name]||'M4 4h16v13H9l-5 4z')+'"/></svg>';
  const number=v=>Number.isFinite(v);
  const money=v=>number(v)?moneyFmt.format(v/100):null;
  const units=v=>number(v)?numFmt.format(v)+' un.':null;
  function ms(value){
    if(!number(value)||value<0)return null;
    if(value>0&&value<1000)return numFmt.format(value)+' ms';
    return value<60000?numFmt.format(value/1000)+' s':Math.floor(value/60000)+' min '+Math.floor(value%60000/1000)+' s';
  }
  function stamp(v,formatter){const date=v&&new Date(v);return date&&Number.isFinite(+date)?formatter.format(date):'';}
  const time=v=>stamp(v,timeFmt),day=v=>stamp(v,dayFmt);
  function diff(start,end){if(!start||!end)return null;const d=Date.parse(end)-Date.parse(start);return d>=0?d:null;}
  const names={pix:'Pix',cartao:'Cartão',card:'Cartão',dinheiro:'Dinheiro',cash:'Dinheiro',delivery:'Entrega',pickup:'Retirada',novo:'Novo',meia_vida:'Meia-vida',remold:'Remold',aceitar:'Aceitar a proposta',contrapropor:'Fazer contraproposta',manter:'Manter a condição',aguardar_dado:'Aguardar informação',oferecer_retirada:'Oferecer retirada',pedir_proposta:'Pedir proposta ao cliente',seguir_tabela:'Seguir o preço de tabela',pending:'Aguardando parecer',approved:'Aval registrado',sending:'Oferta em envio',published:'Oferta publicada',consumed:'Oferta utilizada',paused:'Consulta pausada',expired:'Prazo encerrado',declined:'Sem oferta aprovada',cancelled:'Cancelada',failed:'Falha na consulta'};
  const label=v=>names[v]||null;
  function pairs(items){return '<dl class="mh-data">'+items.filter(([,v])=>v!=null).map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl>';}
  const notice=(message,cls='')=>'<p class="mh-note '+cls+'">'+esc(message)+'</p>';
  function product(c){
    const f=c.ficha||{},name=f.medida||c.produto?.nome||'Produto sem identificação',sub=[f.marca,label(f.condicao),units(c.quantidade)].filter(Boolean);
    return '<div class="mh-product">'+symbol('tire')+'<div><strong>'+esc(name)+'</strong><span>'+esc(sub.join(' · '))+'</span><span>'+esc([label(c.pagamento),label(c.modalidade)].filter(Boolean).join(' · '))+'</span></div></div>';
  }
  function facts(c,stock){
    const f=c.ficha, routes=f?.rotas,routeCost=f?.custo_incremental_entrega_centavos;
    const contrib=[c.aval_centavos,f?.custo_produtos_para_quantidade_centavos,routeCost].every(number)?c.aval_centavos-f.custo_produtos_para_quantidade_centavos-routeCost:null;
    let html='<section class="mh-box mh-private"><h4>'+symbol('lock')+' Dados na consulta</h4>';
    if(f){
      html+=pairs([['Disponíveis',units(f.disponivel)],['Reservados',units(f.reservado)],['Vendas líquidas em 30 dias',units(f.vendas_liquidas_30_dias)],['Entradas previstas',units(f.entradas_previstas)],['Cobertura estimada',number(f.cobertura_estimada_dias)?numFmt.format(f.cobertura_estimada_dias)+' dias':null],['Custo por unidade',money(f.custo_unitario_centavos)],['Custo adicional da entrega',money(routeCost)],['Contribuição direta¹',money(contrib)]]);
      if(number(contrib))html+=notice('¹ Total aprovado menos custo dos produtos e custo adicional da entrega.');
      if(c.modalidade==='delivery'){
        if(routes)html+='<h5>Rotas no momento da leitura</h5>'+pairs([['Rotas abertas',routes.rotas_abertas],['Entregas pendentes',routes.entregas_pendentes],['Rotas com município igual',routes.rotas_com_municipio_cadastrado_igual],['Média de despesas por rota com registro · 30 dias',money(routes.historico_30_dias?.media_despesas_aprovadas_por_rota_com_registro_centavos)]]);
        if(!routes||f.rota_compativel_confirmada==null)html+=notice('Encaixe da entrega na rota sem confirmação.');
      }
      if(c.lida_em)html+=notice('Leitura de '+day(c.lida_em)+' às '+time(c.lida_em)+'.');
    } else html+=notice(c.estado==='pending'?'Aguardando o registro da leitura dos dados.':'A ficha histórica de estoque e custos está indisponível para esta consulta.');
    if(stock&&c.produto?.id)html+='<button type="button" class="mh-link" data-milly-stock>'+esc(f?.medida?'Ver estoque de '+f.medida:'Abrir estoque')+' '+symbol('arrow')+'</button>';
    return html+'</section>';
  }
  function orderFor(turn){return turn?.consulta?.pedido||turn?.pedido||null;}
  function compare(turn){
    const c=turn?.consulta,o=orderFor(turn),approved=money(c?.aval_centavos),charged=money(o?.total_centavos);
    let status,kind='neutral';
    if(!o)status='Sem pedido vinculado';
    else if(!c?.pedido||approved===null||charged===null)status='Sem comparação disponível';
    else if(c.aval_centavos===o.total_centavos){status='Valores conferem';kind='match';}
    else {status='Divergência de valores';kind='mismatch';}
    return {c,o,approved,charged,status,kind};
  }
  function orderButton(o){return '<button type="button" class="mh-order-link" data-milly-order>'+symbol('order')+'Ver pedido '+esc(o.numero||'vinculado')+symbol('chevron')+'</button>';}
  function orderDetails(o){
    const orderStatus={open:'Aberto',confirmed:'Confirmado',pending:'Pendente',completed:'Concluído',cancelled:'Cancelado',delivered:'Entregue'};
    return '<div class="mh-order-detail"><h5>Detalhes do pedido</h5>'+pairs([['Situação',orderStatus[o.status]||'Sem informação'],['Pagamento',label(o.pagamento)],['Modalidade',label(o.modalidade)],['Data',day(o.criado_em)||null]])+
      (o.itens||[]).map(i=>'<div class="mh-item"><strong>'+esc(i.nome||'Produto')+'</strong><span>'+esc([units(i.quantidade),money(i.unitario_centavos)&&(money(i.unitario_centavos)+' / un.')].filter(Boolean).join(' · '))+'</span>'+(i.desconto_centavos>0?'<span>Desconto '+esc(money(i.desconto_centavos))+'</span>':'')+'</div>').join('')+'</div>';
  }
  function verification(turn,expanded,mobile){
    const {c,o,approved,charged,status,kind}=compare(turn);
    if(!c&&!o)return '';
    const title=mobile&&o?'Pedido '+(o.numero||'vinculado'):'Conferência do pedido';
    let html='<section class="mh-box mh-verification"><h4>'+symbol('order')+esc(title)+'</h4>';
    html+=mobile?'<div class="mh-values"><span>Aval da Milly<b>'+esc(approved||'—')+'</b></span><span>Valor no pedido<b>'+esc(charged||'—')+'</b></span></div>':
      pairs([['Tabela por unidade',money(c?.tabela_unitaria_centavos)],['Frete',money(c?.frete_centavos)],['Proposta do cliente',money(c?.proposta_centavos)],['Aval da Milly',approved||'—'],['Valor no pedido',charged||'—']]);
    html+='<p class="mh-compare '+kind+'">'+symbol(kind==='match'?'check':'order')+esc(status)+'</p>';
    if(o)html+=orderButton(o)+(expanded?orderDetails(o):'');
    return html+'</section>';
  }
  function eventRow(when,title,body,extra=''){
    return '<div class="mh-event '+extra+'"><time>'+esc(time(when)||'—')+'</time><div><b>'+esc(title)+'</b>'+body+'</div></div>';
  }
  function timing(t){
    const c=t.consulta;if(!c)return '';
    const times=[['Antes da consulta',diff(t.cliente?.em,c.solicitada_em)],['Com a Milly',c.tempo_milly_ms],['Após o parecer',diff(c.decidida_em,t.atendente?.em)]];
    return '<div class="mh-timing" aria-label="Tempo das etapas">'+times.map(([name,value])=>'<span>'+esc(name)+'<b>'+esc(ms(value)||'—')+'</b></span>').join('')+'</div>';
  }
  function body(t){
    const c=t.consulta;
    let html=eventRow(t.cliente?.em,'Cliente','<p>'+esc(t.cliente?.texto||'Mensagem sem texto registrado.')+'</p>','customer');
    if(c){
      const offer=money(c.proposta_centavos);
      const req=[offer&&('Proposta de '+offer),units(c.quantidade),label(c.pagamento),label(c.modalidade)].filter(Boolean).join(' · ');
      html+='<div class="mh-private-log"><h4>'+symbol('lock')+'Consulta privada'+(ms(c.tempo_milly_ms)?'<small>'+ms(c.tempo_milly_ms)+'</small>':'')+'</h4>';
      html+=eventRow(c.solicitada_em,'Atendente → Milly','<p>'+esc(req||'Consulta registrada')+'</p>');
      if(c.decidida_em||c.decisao){const answer=[label(c.decisao),money(c.aval_centavos),label(c.orientacao)].filter(Boolean).join(' · ');
        html+=eventRow(c.decidida_em,'Milly → Atendente','<p>'+esc(answer||'Parecer registrado')+'</p>'+(c.justificativa?'<p>'+esc(c.justificativa)+'</p>':''));}
      html+=notice(label(c.estado)||'Situação da consulta indisponível.','mh-consult-status');
      if(c.valida_ate&&number(c.aval_centavos))html+=notice('Oferta válida até '+day(c.valida_ate)+' às '+time(c.valida_ate)+'.');
      html+='</div>';
    } else html+=notice('Sem consulta à Milly neste turno.');
    if(t.atendente)html+=eventRow(t.atendente.em,'Atendente → Cliente','<p>'+esc(t.atendente.texto||'Resposta sem texto registrado.')+'</p>','outbound');
    else html+=notice('Sem resposta pública vinculada a este turno.');
    return html+timing(t);
  }
  function html(data,stock){
    const {turns,selected,opened,orderOpen,next,olderPending,error,loading}=data;
    if(!turns.length)return '<div class="mh-state" role="status">'+symbol(loading?'clock':'chat')+'<h3>'+esc(loading?'Carregando o histórico…':error?'Histórico indisponível':'Nenhum turno registrado')+'</h3>'+
      (error?notice(error)+'<button data-milly-retry type="button" class="mh-link">Tentar novamente</button>':loading?'':notice('As mensagens públicas do cliente aparecem aqui quando são registradas.'))+'</div>';
    const turn=turns.find(t=>t.id===selected),c=turn?.consulta;
    let timeline=data.pageCount>1?'<div class="mh-history-refresh">Você está vendo turnos anteriores. <button type="button" class="mh-link" data-milly-retry>Atualizar histórico</button></div>':'';
    if(next)timeline+='<button class="mh-older" type="button" data-milly-older '+(olderPending?'disabled':'')+'>'+ (olderPending?'Carregando…':'Carregar turnos anteriores')+'</button>';
    let lastDay='';
    turns.forEach((t,i)=>{
      const date=day(t.cliente?.em);if(date!==lastDay){timeline+='<div class="mh-date">'+esc(date)+'</div>';lastDay=date;}
      const title=t.consulta?'Negociação':t.pedido?'Pedido':'Atendimento',dur=ms(t.tempo_resposta_ms),open=t.id===opened;
      const count=t.numero||(next?null:i+1);
      timeline+='<article class="mh-turn '+(open?'expanded':'')+'"><h4><button type="button" data-milly-turn="'+esc(t.id)+'" aria-expanded="'+open+'">'+symbol('chevron')+'<span>'+(count?'Turno '+esc(count)+' · ':'')+title+'</span><small>'+symbol('clock')+esc(dur||'Tempo indisponível')+'</small></button></h4>'+
        (open?'<div class="mh-events">'+body(t)+'</div>':'')+'</article>';
      if(t.id===selected&&c)timeline+='<details class="mh-mobile-facts" '+(data.factsOpen?'open':'')+'><summary>'+symbol('lock')+' Estoque e custo na consulta '+symbol('chevron')+'</summary>'+facts(c,stock)+'</details>';
    });
    const privateBadge='<span class="mh-eyebrow">'+symbol('lock')+'Acesso do proprietário</span>';
    return '<div class="mh-layout"><section class="mh-central"><div class="mh-heading"><div><h3>Histórico de negociações</h3>'+privateBadge+'</div></div>'+
      (error?'<div role="alert" class="mh-retry">'+esc(error)+' <button data-milly-retry>Tentar novamente</button></div>':'')+
      '<div class="mh-mobile-summary">'+verification(turn,orderOpen,true)+'</div>'+timeline+'</section>'+
      '<aside class="mh-sidebar" aria-label="Ficha da negociação"><h3>Ficha da negociação</h3>'+(c?product(c):notice('Turno sem consulta à Milly.'))+verification(turn,orderOpen,false)+(c?facts(c,stock):'')+'</aside></div>';
  }
  ch.millyView={html,symbol,orderFor};
}());
