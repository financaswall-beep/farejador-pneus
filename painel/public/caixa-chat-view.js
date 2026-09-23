(function(){
  'use strict';
  const C=window.Caixa,ch=C.chat,s=ch.state;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths={human:'M16 21H4v-2a6 6 0 0 1 12 0v2ZM14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    bot:'M12 3v3m-2-3h4M6 7h12a2 2 0 0 1 2 2v10H4V9a2 2 0 0 1 2-2Zm2 5h1m6 0h1m-8 4h8M1 12v4m22-4v4',
    back:'m15 5-7 7 7 7',send:'m3 3 18 9-18 9 4-9-4-9Zm4 9h14',mic:'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6',
    camera:'M8 6l2-3h4l2 3h5v15H3V6h5Zm8 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    paperclip:'m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2m-7 13 8-8',
    refresh:'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14 0M5 17a8 8 0 0 0 14 0',
    filter:'M3 5h18M6 12h12M9 19h6',chat:'M4 3h16v14H9l-5 4V3Zm4 5h8m-8 4h5',close:'m6 6 12 12M6 18 18 6',photo:'M3 3h18v18H3V3Zm0 13 6-6 12 10M16 7h.01'};
  ch.icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.chat}"/></svg>`;
  ch.escape=esc;ch.safeUrl=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch(_){return '';}};
  const time=value=>value?new Date(value).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'';
  ch.currency=value=>Number(value||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  function wait(value){const m=Math.max(0,Math.floor((Date.now()-new Date(value))/60000));return m<1?'Agora':m<60?m+' min':m<1440?Math.floor(m/60)+' h':Math.floor(m/1440)+' d';}
  function channelKey(row){const raw=String(row.channel_type||'').toLowerCase();return ['whatsapp','instagram','facebook'].find(key=>raw.includes(key))||'web';}
  function channel(row){return ({whatsapp:'WhatsApp',instagram:'Instagram',facebook:'Facebook',web:'Chatwoot'})[channelKey(row)];}
  const channelPaths={
    whatsapp:'<path d="M20.5 11.8a8.4 8.4 0 0 1-12.4 7.4L3 20.5l1.4-5A8.4 8.4 0 1 1 20.5 11.8Z"/><path d="M8.3 7.7c.4-.3 1.1 1.4 1.2 1.7s-.6.9-.6 1.1c.5 1.3 1.6 2.4 3 3 .3.1.8-.9 1.1-.9s2 .8 2.1 1.1c.2.8-.8 1.6-1.5 1.7-2.5.4-6.7-3.6-6.8-6.2 0-.6.7-1.5 1.5-1.5Z"/>',
    instagram:'<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r=".8" fill="currentColor" stroke="none"/>',
    facebook:'<path d="M14 21v-8h3l.5-4H14V7c0-1 .4-1.5 1.7-1.5H18V2.2A25 25 0 0 0 15 2c-3 0-5 1.8-5 5v2H7v4h3v8" fill="currentColor" stroke="none"/>',
    web:'<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z"/><path d="M8 9h8m-8 4h5"/>'};
  function channelBadge(row){return `<span class="chat-channel-badge ${channelKey(row)}" role="img" aria-label="${channel(row)}" title="${channel(row)}"><svg viewBox="0 0 24 24" aria-hidden="true">${channelPaths[channelKey(row)]}</svg></span>`;}
  function avatar(row){const url=ch.safeUrl(s.avatars.get(row.id));return `<span class="chat-avatar" data-avatar="${esc(row.id)}"><span class="chat-avatar-initials">${esc((row.name||'Cliente').trim().split(/\s+/).slice(0,2).map(v=>v[0]||'').join('').toUpperCase())}</span>${url?`<img src="${esc(url)}" alt="" decoding="async" referrerpolicy="no-referrer">`:''}${channelBadge(row)}</span>`;}
  ch.avatar=avatar;
  ch.updateAvatars=function(id){
    document.querySelectorAll('[data-avatar]').forEach(node=>{
      if(id&&node.dataset.avatar!==id)return;const url=ch.safeUrl(s.avatars.get(node.dataset.avatar));let img=node.querySelector('img');
      if(!url){img?.remove();return;}if(!img){img=document.createElement('img');img.alt='';img.decoding='async';img.referrerPolicy='no-referrer';node.append(img);}
      img.onerror=()=>ch.avatarFailed(node.dataset.avatar,url);if(img.getAttribute('src')!==url)img.src=url;
    });
  };
  function controls(row){return ['human','bot'].map(mode=>`<button type="button" data-control="${mode==='human'?'takeover':'resume'}" data-id="${esc(row.id)}"
    class="chat-mode ${mode} ${row.mode===(mode==='human'?'human':'auto')?'selected':''}" aria-label="${mode==='human'?'Assumir atendimento':'Ativar bot'}"
    title="${mode==='human'?'Assumir atendimento':'Ativar bot'}" aria-pressed="${row.mode===(mode==='human'?'human':'auto')}">${ch.icon(mode)}</button>`).join('');}
  const panel=document.createElement('section');panel.id='chat-panel';panel.className='chat-panel hidden';
  panel.innerHTML=`<section class="chat-queue"><header class="chat-title"><div><h2>Conversas</h2><small id="chat-connection">Conectando…</small></div><button id="chat-refresh" class="chat-icon" aria-label="Atualizar conversas">${ch.icon('refresh')}</button></header>
    <div class="chat-search"><input id="chat-search" type="search" placeholder="Buscar cliente ou medida" aria-label="Buscar cliente ou medida" maxlength="100"><button id="chat-filters-button" class="chat-icon" aria-label="Filtrar conversas" aria-expanded="false">${ch.icon('filter')}</button></div>
    <div id="chat-filters" class="chat-filters hidden"><label>Canal<select id="chat-channel"><option value="">Todos os canais</option><option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option><option value="web">Chatwoot</option></select></label><label><input id="chat-closed" type="checkbox"> Incluir encerradas</label></div>
    <nav class="chat-tabs" aria-label="Filtrar fila"><button data-filter="needs" class="selected">Precisam de você <b id="chat-needs-count">0</b></button><button data-filter="all">Todas</button><button data-filter="bot">Com o bot</button></nav>
    <p class="chat-sort">↕ Maior espera primeiro</p><div id="chat-error" role="alert"></div><div id="chat-list"></div><button id="chat-more" class="chat-more hidden">Ver mais conversas</button></section>
    <section class="chat-thread" id="chat-thread"><div id="chat-no-selection">${ch.icon('chat')}<h3>Seu atendimento, em um só lugar</h3><p>Selecione uma conversa para começar.</p></div>
    <div id="chat-conversation" class="hidden"><header class="chat-contact" id="chat-contact"></header>
    <div id="chat-owner" class="chat-owner"></div><div id="chat-context" class="chat-context"></div>
    <div id="chat-thread-error" role="alert"></div><div id="chat-photo-notice" class="chat-photo-notice hidden" role="status"></div>
    <div id="chat-timeline" class="chat-timeline" role="log" aria-label="Mensagens da conversa"><button id="chat-older" class="chat-more hidden">Carregar mensagens anteriores</button><div id="chat-messages"></div><div id="chat-photo-card"></div></div>
    <div id="chat-media-preview" class="chat-media-preview hidden"></div>
    <form id="chat-compose" class="chat-compose"><button type="button" id="chat-attach" class="chat-icon" aria-label="Anexar arquivo">${ch.icon('paperclip')}</button><textarea id="chat-input" rows="1" maxlength="4000" placeholder="Mensagem…" aria-label="Mensagem"></textarea><button type="button" id="chat-mic" class="chat-mic" aria-label="Gravar áudio">${ch.icon('mic')}</button><button type="submit" id="chat-send" class="chat-send" aria-label="Enviar mensagem">${ch.icon('send')}</button><small id="chat-compose-hint">Ao digitar, você assume o atendimento.</small></form></div></section>`;
  document.getElementById('cash-panel').before(panel);
  const sheet=document.createElement('dialog');sheet.id='chat-sheet';sheet.className='chat-sheet';sheet.setAttribute('aria-label','Ficha do cliente');document.body.append(sheet);
  const nav=document.querySelector('.bottom-nav'),more=document.createElement('button');
  more.id='nav-chat-more';more.className='chat-nav-more';more.type='button';more.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg><span>Mais</span>';nav.append(more);
  more.onclick=()=>{
    sheet.setAttribute('aria-label','Mais opções');
    const shortcuts=[...nav.querySelectorAll('button[data-tab]')].filter(b=>!b.classList.contains('hidden')&&!['sales','conversations','pickups','stock'].includes(b.dataset.tab));
    sheet.innerHTML='<header><h2>Mais opções</h2><button data-close aria-label="Fechar opções">×</button></header><div class="chat-shortcuts">'+shortcuts.map(b=>`<button data-shortcut="${esc(b.id)}">${b.innerHTML}</button>`).join('')+'</div>';
    sheet.showModal();
  };
  sheet.addEventListener('click',event=>{const button=event.target.closest('[data-shortcut]');if(button){sheet.close();document.getElementById(button.dataset.shortcut)?.click();}});
  ch.renderConnection=()=>{ch.el('connection').textContent=s.connected?'Atualização ao vivo':'Atualização automática • reconectando';};
  ch.renderQueue=function(){
    ch.el('error').textContent=s.error;ch.el('needs-count').textContent=s.needsTotal||0;
    ch.el('more').classList.toggle('hidden',!s.hasMore);
    panel.querySelectorAll('[data-filter]').forEach(el=>{el.classList.toggle('selected',el.dataset.filter===s.filter);el.setAttribute('aria-pressed',String(el.dataset.filter===s.filter));});
    ch.el('list').innerHTML=s.rows.map(row=>{
      const measures=(row.interests||[]).map(i=>i.measure).join(' · '),location=row.location?.label||'';
      const label=row.photo_request_id?(row.photo_status==='answered'?'Foto em envio':'Pediu foto'):row.send_failed?'Falha no envio':row.mode==='human'?'Atendimento humano':row.waiting?'Resposta pendente':'Aguardando cliente';
      return `<article class="chat-row ${row.id===s.id?'selected':''}"><button class="chat-open-row" data-open="${esc(row.id)}">${avatar(row)}<span class="chat-row-text"><strong>${esc(row.name||'Cliente')}</strong><span>${esc(row.last_message||'Anexo recebido')}</span><small>${esc([measures,location].filter(Boolean).join(' · ')||channel(row))}</small><em class="${row.photo_request_id?'photo':''}">${row.photo_request_id?ch.icon('camera'):''}${esc(label)}</em></span></button><div class="chat-row-actions"><small>${row.last_customer_at?wait(row.last_customer_at):''}</small><div>${controls(row)}</div></div></article>`;
    }).join('')||`<div class="chat-empty">${s.error?'':'Nenhuma conversa neste filtro.'}</div>`;
    ch.updateAvatars();ch.loadQueueAvatars();
  };
  function messageHtml(m){
    const inbound=m.sender_type==='contact',system=m.message_type===2,bot=m.outbound_kind&&!m.outbound_kind.startsWith('operator_')||m.sender_type==='agent_bot';
    const status=m.sender_type?({sent:'Enviado',delivered:'Entregue',read:'Lido',failed:'Falhou'}[m.status]||''):
      ({pending:'Na fila',sending:'Enviando…',sent_api_ack:'Aceito pelo Chatwoot',delivered:'Confirmado no histórico',dead_letter:m.last_error_kind==='ambiguous'?'Envio sem confirmação':'Falhou',failed:m.local?'Falhou':'Tentando novamente',unknown:'Sem confirmação — conferir',superseded:'Cancelado'}[m.status]||'');
    const attachments=(m.attachments||[]).map(a=>{
      const url=ch.safeUrl(a.url);if(a.type==='location'&&a.latitude!=null&&a.longitude!=null)return `<a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.latitude+','+a.longitude)}">Localização compartilhada ↗</a>`;
      if(!url)return '<small>Anexo indisponível</small>';
      if(a.type==='image')return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img class="chat-photo" src="${esc(url)}" alt="Foto enviada na conversa" loading="lazy" referrerpolicy="no-referrer"></a>`;
      if(a.type==='audio')return `<audio controls preload="none" src="${esc(url)}"></audio>`;
      if(a.type==='video')return `<video controls preload="none" src="${esc(url)}"></video>`;
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Abrir anexo ↗</a>`;
    }).join('');
    const retry=m.status==='dead_letter'&&m.last_error_kind!=='ambiguous'?`<button data-retry-failed="${esc(m.client_token)}">Tentar novamente</button>`:
      m.request&&m.local&&['failed','unknown'].includes(m.status)?`<button data-retry="${esc(m.client_token)}">${m.status==='unknown'?'Verificar envio':'Tentar novamente'}</button>`:'';
    return `<div class="chat-bubble ${inbound?'incoming':bot?'bot':'outgoing'} ${system?'system':''}">${bot?'<small class="chat-sender">Bot</small>':''}${attachments}${m.mime&&!attachments?`<small>${m.mime.startsWith('audio/')?'Áudio':m.mime.startsWith('image/')?'Foto':'Anexo'} • ${esc(m.filename||'aguardando confirmação')}</small>`:''}<p>${esc(m.content)}</p><footer><time>${time(m.sent_at)}</time>${!inbound?`<span>${esc(status)}</span>`:''}</footer>${retry}</div>`;
  }
  ch.renderThread=function(){
    ch.el('no-selection').classList.toggle('hidden',!!s.id);ch.el('conversation').classList.toggle('hidden',!s.id);
    panel.classList.toggle('has-conversation',!!s.id);if(!s.id)return;
    const row=s.detail||s.rows.find(r=>r.id===s.id)||{id:s.id,name:'Carregando…',mode:'auto'};
    ch.el('contact').innerHTML=`<button id="chat-back" class="chat-icon" aria-label="Voltar às conversas">${ch.icon('back')}</button>${avatar(row)}<div><h3>${esc(row.name||'Cliente')}</h3><small>${esc(channel(row))}${row.location?.label?' · '+esc(row.location.label):''}</small></div><div class="chat-top-controls">${controls(row)}</div>`;
    ch.updateAvatars(s.id);
    ch.el('owner').textContent=row.mode==='human'?'Atendimento humano · bot pausado':'Bot atendendo';
    const measures=(row.interests||[]).flatMap(i=>[i.measure,...i.variants.map(v=>v.condition==='meia_vida'?'Meia-vida':v.condition==='novo'?'Novo':v.condition).filter(Boolean)]);
    const order=row.orders?.[0];
    ch.el('context').innerHTML=`<div>${[...new Set(measures)].slice(0,4).map(m=>`<span>${esc(m)}</span>`).join('')}<span>${order?'Pedido '+esc(({cancelled:'cancelado',pending:'pendente',confirmed:'confirmado',completed:'concluído'})[order.status]||order.status):'Sem pedido'}</span></div><button id="chat-customer">Ver ficha ↓</button>`;
    ch.el('thread-error').textContent=s.threadError;
    ch.el('older').classList.toggle('hidden',!s.next);
    const timeline=ch.el('timeline'),nearBottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<100;
    const all=[...s.messages.values(),...[...s.pending.values()].filter(m=>m.conversation_id===s.id&&!([...s.messages.values()].some(x=>x.client_token===m.client_token)))].sort((a,b)=>new Date(a.sent_at)-new Date(b.sent_at));
    const list=ch.el('messages'),existing=new Map([...list.children].map(node=>[node.dataset.key,node]));
    const keys=new Set();let lastDay='',position=0;
    for(const m of all){const key=m.client_token||m.id;keys.add(key);let node=existing.get(key);const day=new Date(m.sent_at).toLocaleDateString('pt-BR');
      const html=(day!==lastDay?`<div class="chat-day">${esc(day)}</div>`:'')+messageHtml(m);lastDay=day;
      if(!node){node=document.createElement('article');node.dataset.key=key;}
      if(node._html!==html){node.innerHTML=html;node._html=html;}
      if(list.children[position]!==node)list.insertBefore(node,list.children[position]||null);position++;
    }
    existing.forEach((node,key)=>{if(!keys.has(key))node.remove();});
    const photo=row.photos?.find(p=>['pending','answered'].includes(p.status));
    ch.el('photo-card').innerHTML=photo?`<section class="chat-photo-task"><div>${ch.icon('camera')}<div><h3>${photo.status==='pending'?'Enviar foto do pneu':'Foto aguardando envio'}</h3><p>${esc(photo.tire_size)} · ${photo.status==='pending'?'solicitação pendente':'a confirmação aparecerá aqui'}</p></div></div>${photo.status==='pending'?`<footer><button data-photo="camera" data-photo-id="${esc(photo.id)}">${ch.icon('camera')}Tirar foto</button><button data-photo="gallery" data-photo-id="${esc(photo.id)}">${ch.icon('photo')}Galeria</button></footer>`:''}</section>`:'';
    ch.el('send').disabled=s.sending;ch.el('input').disabled=!s.detail;
    if(nearBottom)requestAnimationFrame(()=>{timeline.scrollTop=timeline.scrollHeight;});
  };
  ch.render=function(){ch.renderQueue();ch.renderThread();ch.renderConnection();};
  ch.photoNotice=function(row){const n=ch.el('photo-notice');n.innerHTML=`${ch.icon('camera')}<button data-open="${esc(row.id)}"><strong>${esc(row.name||'Cliente')} pediu uma foto</strong><small>${esc(row.photo_measure)} · Abrir conversa →</small></button><button data-dismiss-photo aria-label="Fechar aviso">×</button>`;n.classList.remove('hidden');};
  panel.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.open){ch.el('photo-notice').classList.add('hidden');ch.open(target.dataset.open);}
    if(target.dataset.control)void ch.setControl(target.dataset.id,target.dataset.control);
    if(target.dataset.filter){s.filter=target.dataset.filter;ch.changeFilter();}
    if(target.dataset.retry)void ch.send(s.pending.get(target.dataset.retry));
    if(target.dataset.retryFailed)void ch.retryFailed(target.dataset.retryFailed);
    if(target.hasAttribute('data-dismiss-photo'))ch.el('photo-notice').classList.add('hidden');
    if(target.id==='chat-back')ch.back();if(target.id==='chat-customer')void ch.openCustomer();
    if(target.id==='chat-refresh'){ch.refreshAvatars();void ch.loadList();void ch.loadThread();}
    if(target.id==='chat-more')void ch.loadList(true);if(target.id==='chat-older')void ch.loadThread(true);
  });
  let searchTimer;ch.el('search').addEventListener('input',event=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{s.search=event.target.value;ch.changeFilter();},300);});
  ch.el('filters-button').onclick=()=>{const hidden=ch.el('filters').classList.toggle('hidden');ch.el('filters-button').setAttribute('aria-expanded',String(!hidden));};
  ch.el('channel').onchange=event=>{s.channel=event.target.value;ch.changeFilter();};
  ch.el('closed').onchange=event=>{s.closed=event.target.checked;ch.changeFilter();};
  ch.el('input').addEventListener('input',()=>{if(s.id){s.drafts.set(s.id,ch.el('input').value);if(ch.el('input').value.trim())void ch.setControl(s.id,'takeover');}});
  ch.el('compose').onsubmit=event=>{event.preventDefault();void ch.send();};
}());
