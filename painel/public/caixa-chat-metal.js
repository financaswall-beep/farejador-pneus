(function(){
  'use strict';
  const C=window.Caixa;if(!C||window.FarejadorBotChat)return;
  const ch=C.chat,s=ch.state,app=C.elements.app,panel=ch.el('panel'),sheet=ch.el('sheet');
  const skin=C.chatMetal={enabled:false,active:()=>skin.enabled&&!C.isPartner()};
  skin.button=(label,action,secondary=false)=>{const b=document.createElement('button');b.type='button';b.className=secondary?'cm-secondary':'cm-primary';b.textContent=label;b.onclick=action;return b;};
  skin.dialog=function(label){const d=document.createElement('dialog');d.className='cm-sheet';d.setAttribute('aria-label',label);app.appendChild(d);return d;};
  skin.header=function(title,close,subtitle){const h=document.createElement('header');h.className='cm-sheet-heading';const b=skin.button('‹',close,true);b.className='cm-back';b.setAttribute('aria-label','Voltar');const copy=document.createElement('div'),t=document.createElement('h2');t.textContent=title;copy.appendChild(t);if(subtitle){const p=document.createElement('p');p.textContent=subtitle;copy.appendChild(p);}h.append(b,copy);return h;};
  const originParent=sheet.parentNode,originNext=sheet.nextSibling;
  const reset=ch.reset;ch.reset=function(){skin.filters?.close();skin.media?.leave();reset();};
  skin.sync=function(tab){
    skin.enabled=!C.isPartner()&&tab==='conversations';
    if(skin.enabled){if(sheet.parentNode!==app)app.appendChild(sheet);skin.prepare();}
    else{if(sheet.open)sheet.close();skin.filters?.close();skin.media?.leave();if(sheet.parentNode!==originParent)originParent.insertBefore(sheet,originNext);}
  };
  skin.prepare=function(){
    if(!panel.querySelector('.cm-queue-heading')){const h=document.createElement('h2');h.className='cm-queue-heading';h.textContent='Conversas';panel.querySelector('.chat-title').prepend(h);}
    const search=panel.querySelector('.chat-search');if(!search.querySelector('.cm-search-icon')){const icon=C.createSvg([{tag:'circle',cx:'10',cy:'10',r:'7'},{d:'m15 15 6 6'}]);icon.classList.add('cm-search-icon');search.prepend(icon);}
    const tabs=panel.querySelector('.chat-tabs');['all','needs','bot'].forEach(key=>tabs.appendChild(tabs.querySelector('[data-filter="'+key+'"]')));
    const needs=tabs.querySelector('[data-filter="needs"]');if(needs.firstChild?.nodeType===3)needs.firstChild.nodeValue='Precisam de você · ';
    skin.filters?.bind();
  };
  const renderQueue=ch.renderQueue;
  ch.renderQueue=function(){renderQueue();if(!skin.active())return;skin.prepare();
    const all=panel.querySelector('[data-filter="all"]');all.textContent='Todas'+(s.filter==='all'&&Number.isFinite(s.total)?' · '+s.total:'');
    panel.querySelectorAll('.chat-row').forEach(card=>{
      const open=card.querySelector('[data-open]'),row=s.rows.find(r=>r.id===open?.dataset.open);if(!row)return;
      const tag=card.querySelector('.chat-row-text em');
      card.dataset.attention=row.photo_request_id||row.send_failed||row.waiting?'yes':'no';
      if(row.mode==='auto'&&!row.waiting&&!row.photo_request_id&&!row.send_failed){tag.textContent='Bot atendendo';tag.classList.add('cm-bot-tag');}
      const arrow=document.createElement('span');arrow.className='cm-row-arrow';arrow.textContent='›';arrow.setAttribute('aria-hidden','true');open.appendChild(arrow);
    });
  };
  const renderThread=ch.renderThread;
  ch.renderThread=function(){renderThread();if(!skin.active()||!s.id)return;
    const contact=ch.el('contact'),context=ch.el('context'),controls=contact.querySelector('.chat-top-controls');
    let bar=document.getElementById('cm-chat-controls');if(!bar){bar=document.createElement('div');bar.id='cm-chat-controls';ch.el('owner').after(bar);}
    bar.replaceChildren();if(controls){[...controls.children].forEach(button=>{const text=document.createElement('span');text.textContent=button.dataset.control==='takeover'?'Humano':'Ativar bot';button.appendChild(text);bar.appendChild(button);});controls.remove();}
    const ficha=ch.el('customer');if(ficha){ficha.className='cm-ficha';ficha.innerHTML=ch.icon('human')+'<span>Ficha</span>';contact.appendChild(ficha);}
    context.querySelectorAll('span').forEach(tag=>tag.classList.add('cm-context-tag'));
    const photo=ch.el('photo-card');photo.querySelectorAll('[data-photo="camera"]').forEach(b=>{b.innerHTML=ch.icon('camera')+'<span>Fotografar</span>';});
    const title=photo.querySelector('h3');if(title&&photo.querySelector('[data-photo]'))title.textContent='Foto solicitada';
    const request=s.detail?.photos?.find(p=>p.status==='pending'),caption=photo.querySelector('p');if(request&&caption){const interest=s.detail.interests?.find(i=>i.measure===request.tire_size),conditions=[...new Set((interest?.variants||[]).map(v=>({novo:'Novo',meia_vida:'Meia-vida',remold:'Remold'})[v.condition]).filter(Boolean))];caption.textContent=request.tire_size+(conditions.length===1?' · '+conditions[0]:'');}
    const today=new Date().toLocaleDateString('pt-BR');ch.el('messages').querySelectorAll('.chat-day').forEach(day=>{day.dataset.cmDate||=day.textContent;day.textContent=day.dataset.cmDate===today?'Hoje':day.dataset.cmDate;});
  };
  const observer=new MutationObserver(()=>{if(!skin.active()||!sheet.open)return;
    sheet.classList.add('cm-client-sheet');const header=sheet.querySelector('.chat-customer-header');if(header){const close=header.querySelector('[data-close]');if(close){close.textContent='‹';close.setAttribute('aria-label','Voltar à conversa');header.prepend(close);}}
    const contact=sheet.querySelector('.chat-customer-contact:not(.cm-client-location)');if(contact?.children.length>2){const location=document.createElement('dl');location.className='chat-customer-contact cm-client-location';location.appendChild(contact.lastElementChild);contact.after(location);}
    const email=contact?.children[1]?.querySelector('dd'),phoneCopy=contact?.querySelector('[data-customer-copy]');if(email&&phoneCopy&&!email.querySelector('button')){const value=email.textContent.trim();if(value&&value!=='Não informado'){const copy=phoneCopy.cloneNode(true),text=document.createElement('span');text.textContent=value;copy.removeAttribute('data-customer-copy');copy.dataset.cmEmail=value;copy.setAttribute('aria-label','Copiar e-mail');email.replaceChildren(text,copy);}}
    const back=sheet.querySelector('.chat-customer-footer [data-close]');if(back)back.innerHTML=ch.icon('back')+'<span>Voltar à conversa</span>';
    sheet.querySelectorAll('[data-chat-order]').forEach(row=>{if(!row.dataset.chatOrder||!C.matrixSales?.()||!C.canModule('vendas'))return;row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label','Ver pedido '+row.querySelector('strong').textContent);if(!row.querySelector('.cm-order-arrow')){const a=document.createElement('span');a.className='cm-order-arrow';a.textContent='›';a.setAttribute('aria-hidden','true');row.appendChild(a);}});
  });observer.observe(sheet,{childList:true});
  function openOrder(event){const row=event.target.closest('[data-chat-order][role="button"]');if(!skin.active()||!row)return;sheet.close();void C.openReceipt(row.dataset.chatOrder);}
  sheet.addEventListener('click',async event=>{const button=event.target.closest('[data-cm-email]');if(!skin.active()||!button)return;let message='E-mail copiado.';try{await navigator.clipboard.writeText(button.dataset.cmEmail);}catch(_){message='Selecione o e-mail para copiar.';}const status=sheet.querySelector('.chat-customer-copy-status');if(status)status.textContent=message;});
  sheet.addEventListener('click',openOrder);sheet.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)&&event.target.matches('[data-chat-order][role="button"]')){event.preventDefault();openOrder(event);}});
}());
