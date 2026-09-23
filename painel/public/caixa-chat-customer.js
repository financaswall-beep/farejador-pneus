(function(){
  'use strict';
  const C=window.Caixa,ch=C.chat,esc=ch.escape,s=ch.state,sheet=ch.el('sheet');
  let current=null;
  const paths={crown:'m3 6 4 4 5-7 5 7 4-4-2 13H5L3 6Zm3 9h12',
    phone:'M6 3H3v3c0 8 7 15 15 15h3v-5l-5-2-2 3a15 15 0 0 1-7-7l3-2-2-5H6Z',
    copy:'M9 9h12v12H9V9ZM5 15H3V3h12v2',mail:'M3 5h18v14H3V5Zm0 1 9 7 9-7',
    pin:'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Zm-4 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    bag:'M4 7h16l1 14H3L4 7Zm4 3V6a4 4 0 0 1 8 0v4',receipt:'M5 3h10l4 4v14H5V3Zm9 0v5h5M8 12h8m-8 4h6',
    check:'M9 12l2 2 4-4m7 2a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    tire:'M19 12c0 5-3 9-7 9s-7-4-7-9 3-9 7-9 7 4 7 9Zm-4 0c0 3-1 6-3 6s-3-3-3-6 1-6 3-6 3 3 3 6Z',
    arrow:'m9 5 7 7-7 7',close:'m6 6 12 12M6 18 18 6'};
  const icon=name=>paths[name]?`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`:ch.icon(name);
  function phone(value){
    const raw=String(value||'').trim(),digits=raw.replace(/\D/g,'');
    if(!raw)return '';
    const country=digits.startsWith('55')&&[12,13].includes(digits.length),local=country?digits.slice(2):digits;
    if(!/^[+\d\s().-]+$/.test(raw)||(raw.startsWith('+')&&!country)||![10,11].includes(local.length))return raw;
    return `${country?'+55 ':''}(${local.slice(0,2)}) ${local.slice(2,-4)}-${local.slice(-4)}`;
  }
  const alive=ctx=>current===ctx&&s.id===ctx.id&&s.session===ctx.session&&sheet.open;
  const header=()=>`<header class="chat-customer-header"><h2>Ficha do cliente</h2><button type="button" data-close aria-label="Fechar ficha">${icon('close')}</button></header>`;
  function interestHtml(interest){
    const type=interest.vehicle_type,known=['car','motorcycle'].includes(type);
    const image=type==='car'?'catalog-tire-car.png':'catalog-tire.webp';
    const label=type==='car'?'Carro':type==='motorcycle'?'Moto':'Tipo não identificado';
    const conditions=[...new Set((interest.variants||[]).map(v=>({novo:'Novo',meia_vida:'Meia-vida',remold:'Remold'})[v.condition]).filter(Boolean))];
    return `<div class="chat-customer-interest">${known?`<img src="/operacao/${image}" alt="Pneu de ${type==='car'?'carro':'moto'}" width="42" height="48">`:`<span class="chat-customer-tire-unknown">${icon('tire')}</span>`}
      <div><strong>${esc(interest.measure)}</strong><small>${label}</small></div><div class="chat-customer-conditions">${conditions.map(c=>`<span>${c}</span>`).join('')}</div></div>`;
  }
  function orderHtml(order){
    const date=new Date(order.occurred_at),when=Number.isNaN(date.getTime())?'Data não informada':date.toLocaleDateString('pt-BR');
    const status=({cancelled:'Cancelado',confirmed:'Confirmado',completed:'Concluído',pending:'Pendente',reserved:'Reservado',delivered:'Entregue',picked_up:'Retirado'})[order.status]||order.status||'Sem status';
    return `<article class="chat-customer-order">${icon('receipt')}<div><strong>${esc(order.order_number||'Pedido')}</strong><small>${esc(status)} · ${esc(when)}</small></div><b>${ch.currency(order.total_amount)}</b></article>`;
  }
  function render(ctx){
    const data=ctx.data,customer=data.customer||{},summary=data.summary||{},row=ctx.row;
    const location=customer.shared_location||row.location,orders=data.orders||[],purchases=Number(summary.purchases||0);
    const vip=customer.is_vip===true,classification=typeof customer.is_vip==='boolean';
    const channel=String(row.channel_type||customer.origin||'').toLowerCase();
    const channelName=channel.includes('whatsapp')?'WhatsApp':channel.includes('instagram')?'Instagram':channel.includes('facebook')?'Facebook':'Chatwoot';
    const photos=(row.photos||[]).filter(p=>['pending','answered'].includes(p.status));
    const interests=data.interests||row.interests||[];ctx.phone=phone(customer.phone);
    const address=customer.address||location?.estimated_address;
    sheet.innerHTML=header()+`<div class="chat-customer-body"><div class="chat-customer-name">${ch.avatar({...row,name:customer.name||row.name})}<div><h3>${esc(customer.name||row.name||'Cliente')}</h3>
      <span class="chat-customer-badge ${vip?'vip':''}">${icon(vip?'crown':'human')}${classification?(vip?'Cliente VIP':'Cliente comum'):'Classificação indisponível'}</span>
      <small>${channelName} · ${purchases} ${purchases===1?'compra concluída':'compras concluídas'}</small></div></div>
      <dl class="chat-customer-contact"><div><dt>${icon('phone')}<span>Telefone</span></dt><dd><span>${esc(ctx.phone||'Não informado')}</span>${ctx.phone?`<button type="button" class="chat-customer-copy" data-customer-copy aria-label="Copiar telefone">${icon('copy')}</button>`:''}</dd></div>
      <div><dt>${icon('mail')}<span>E-mail</span></dt><dd>${esc(customer.email||'Não informado')}</dd></div>
      <div><dt>${icon('pin')}<span>Localização</span></dt><dd>${esc(location?.label||'Não informada')}<small>${esc(address||'Endereço completo não informado')}</small></dd></div></dl>
      <section class="chat-customer-card"><h3>${icon('tire')}Pneus de interesse</h3><div class="chat-customer-interests">${interests.map(interestHtml).join('')||'<p>Nenhuma medida registrada.</p>'}</div></section>
      <section class="chat-customer-card"><h3>${icon(photos.length?'camera':'check')}Pendências</h3>${photos.map(p=>`<button type="button" class="chat-customer-pending" data-customer-photo>${icon('camera')}<span><strong>${p.status==='pending'?'Foto solicitada':'Foto aguardando envio'}</strong><small>${esc(p.tire_size)}</small></span>${icon('arrow')}</button>`).join('')||'<p class="chat-customer-no-pending">Nenhuma pendência de foto.</p>'}</section>
      <section class="chat-customer-card"><h3>${icon('bag')}Histórico de compras</h3><div class="chat-customer-stats"><div>${icon('bag')}<b>${purchases}</b><small>${purchases===1?'Compra concluída':'Compras concluídas'}</small></div><div>${icon('receipt')}<b>${ch.currency(summary.total_spent)}</b><small>Total comprado</small></div></div>
      ${(ctx.expanded?orders:orders.slice(0,3)).map(orderHtml).join('')||'<p>Ainda não há compras registradas.</p>'}
      ${(!ctx.expanded&&orders.length>3)||data.next_offset!=null?`<button type="button" class="chat-customer-history" data-customer-history ${ctx.busy?'disabled':''}>${ctx.busy?'Carregando…':ctx.expanded?'Carregar mais compras':'Ver histórico completo'}${icon('arrow')}</button>`:''}
      ${ctx.historyError?'<p role="alert">Não foi possível carregar mais compras. Tente novamente.</p>':''}</section></div>
      <footer class="chat-customer-footer"><button type="button" class="chat-primary" data-close>${icon('chat')}Voltar à conversa</button><small class="chat-sheet-note">Seu rascunho continua na conversa.</small><span class="chat-customer-copy-status" role="status" aria-live="polite"></span></footer>`;
    ch.updateAvatars(ctx.id);
  }
  ch.openCustomer=async function(){
    const id=s.id;if(!id)return;
    const ctx=current={id,session:s.session,row:s.detail||s.rows.find(r=>r.id===id)||{id},data:{},expanded:false,busy:false};
    sheet.classList.add('chat-customer-sheet');sheet.setAttribute('aria-label','Ficha do cliente');
    sheet.innerHTML=header()+'<p class="chat-customer-loading" role="status">Carregando dados…</p>';
    if(!sheet.open)sheet.showModal();
    try{const data=await ch.api(ch.path(id)+'/customer');if(!alive(ctx))return;ctx.data=data||{};render(ctx);}
    catch(error){if(alive(ctx))sheet.innerHTML=header()+`<p class="chat-customer-loading" role="alert">${esc(ch.errorText(error))}</p>`;}
  };
  async function history(ctx){
    if(ctx.busy)return;
    if(!ctx.expanded&&(ctx.data.orders||[]).length>3){ctx.expanded=true;render(ctx);return;}
    if(ctx.data.next_offset==null)return;
    ctx.expanded=true;ctx.busy=true;ctx.historyError=false;render(ctx);
    try{
      const page=await ch.api(ch.path(ctx.id)+'/customer?offset='+encodeURIComponent(ctx.data.next_offset));if(!alive(ctx))return;
      const orders=new Map((ctx.data.orders||[]).map(o=>[o.id,o]));for(const order of page.orders||[])orders.set(order.id,order);
      ctx.data={...ctx.data,orders:[...orders.values()],next_offset:page.next_offset};
    }catch(_){if(alive(ctx))ctx.historyError=true;}
    finally{if(alive(ctx)){ctx.busy=false;render(ctx);}}
  }
  sheet.addEventListener('click',async event=>{
    if(event.target.closest('[data-close]')||event.target===sheet){sheet.close();return;}
    const ctx=current;if(!ctx||!alive(ctx))return;
    if(event.target.closest('[data-customer-history]'))void history(ctx);
    if(event.target.closest('[data-customer-photo]')){sheet.close();ch.el('photo-card')?.scrollIntoView({block:'end'});}
    if(event.target.closest('[data-customer-copy]')&&ctx.phone){
      let message='Telefone copiado.';try{await navigator.clipboard.writeText(ctx.phone);}catch(_){message='Não foi possível copiar. Selecione o telefone e copie.';}
      if(alive(ctx))sheet.querySelector('.chat-customer-copy-status').textContent=message;
    }
  });
  sheet.addEventListener('close',()=>{current=null;sheet.classList.remove('chat-customer-sheet');});
}());
