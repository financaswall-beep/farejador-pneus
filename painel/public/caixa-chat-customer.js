(function(){
  'use strict';
  const C=window.Caixa,ch=C.chat,esc=ch.escape,s=ch.state;
  ch.openCustomer=async function(){
    const id=s.id;if(!id)return;const sheet=ch.el('sheet');
    sheet.innerHTML='<header><h2>Ficha do cliente</h2><button data-close aria-label="Fechar ficha">×</button></header><p>Carregando dados…</p>';
    sheet.setAttribute('aria-label','Ficha do cliente');sheet.showModal();
    try{
      const data=await ch.api(ch.path(id)+'/customer');if(s.id!==id||!sheet.open)return;
      const customer=data?.customer||{},summary=data?.summary||{},location=s.detail?.location;
      const orders=data?.orders||[];
      const status=value=>({cancelled:'Cancelado',confirmed:'Confirmado',completed:'Concluído',pending:'Pendente',reserved:'Reservado',delivered:'Entregue'}[value]||value);
      sheet.innerHTML=`<header><h2>Ficha do cliente</h2><button data-close aria-label="Fechar ficha">×</button></header>
        <div class="chat-customer-name">${ch.avatar(s.detail||{id,name:customer.name})}<div><h3>${esc(customer.name||s.detail?.name||'Cliente')}</h3><small>${esc(s.detail?.channel_type||'Chatwoot')}</small></div></div>
        <dl><dt>Telefone</dt><dd>${esc(customer.phone||'Não informado')}</dd><dt>E-mail</dt><dd>${esc(customer.email||'Não informado')}</dd>
        <dt>Localização</dt><dd>${esc(location?.label||'Não informada')}</dd><dt>Endereço</dt><dd>${esc(customer.address||location?.estimated_address||'Não informado')}</dd></dl>
        <section><h3>Pneus de interesse</h3><div class="chat-customer-chips">${(s.detail?.interests||[]).map(i=>`<span>${esc(i.measure)}</span>`).join('')||'<p>Nenhuma medida registrada.</p>'}</div></section>
        <section><h3>Pendências</h3>${(s.detail?.photos||[]).filter(p=>['pending','answered'].includes(p.status)).map(p=>`<p>${ch.icon('camera')}${esc(p.tire_size)} · ${p.status==='pending'?'Foto solicitada':'Foto aguardando envio'}</p>`).join('')||'<p>Nenhum pedido de foto pendente.</p>'}</section>
        <section><h3>Histórico de compras</h3><div class="chat-customer-stats"><div><b>${Number(summary.purchases||0)}</b><small>Compras concluídas</small></div><div><b>${ch.currency(summary.total_spent)}</b><small>Total comprado</small></div></div>
        ${orders.map(order=>`<article class="chat-customer-order"><div><strong>${esc(order.order_number||'Pedido')}</strong><small>${esc(status(order.status))} · ${new Date(order.occurred_at).toLocaleDateString('pt-BR')}</small></div><b>${ch.currency(order.total_amount)}</b></article>`).join('')||'<p>Ainda não há compras registradas.</p>'}</section>
        <button class="chat-primary" data-close>Voltar à conversa</button><small class="chat-sheet-note">Seu rascunho continua na conversa.</small>`;
    }catch(error){if(sheet.open)sheet.innerHTML='<header><h2>Ficha do cliente</h2><button data-close aria-label="Fechar ficha">×</button></header><p>'+esc(ch.errorText(error))+'</p>';}
  };
  ch.el('sheet').addEventListener('click',event=>{if(event.target.closest('[data-close]')||event.target===ch.el('sheet'))ch.el('sheet').close();});
}());
