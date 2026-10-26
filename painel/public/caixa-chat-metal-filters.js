(function(){
  'use strict';
  const C=window.Caixa,skin=C?.chatMetal;if(!skin)return;
  const ch=C.chat,s=ch.state,dialog=skin.dialog('Filtrar conversas');dialog.id='cm-chat-filters';
  const header=skin.header('Filtrar conversas',()=>dialog.close()),body=document.createElement('form');body.className='cm-filter-form';
  const field=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent='Canal';field.appendChild(legend);
  [['','Todos os canais'],['whatsapp','WhatsApp'],['instagram','Instagram'],['facebook','Facebook'],['web','Chatwoot']].forEach(([value,label])=>{
    const row=document.createElement('label'),radio=document.createElement('input'),text=document.createElement('span');radio.type='radio';radio.name='cm-chat-channel';radio.value=value;text.textContent=label;row.append(radio,text);field.appendChild(row);
  });
  const closed=document.createElement('label');closed.className='cm-filter-closed';const toggle=document.createElement('input');toggle.type='checkbox';toggle.id='cm-chat-closed';const text=document.createElement('span');text.textContent='Incluir encerradas';closed.append(text,toggle);
  const actions=document.createElement('footer');actions.className='cm-sheet-actions';
  function apply(channel,include){s.channel=channel;s.closed=include;ch.el('channel').value=channel;ch.el('closed').checked=include;ch.changeFilter();dialog.close();ch.el('filters-button').setAttribute('aria-expanded','false');}
  const submit=skin.button('Aplicar filtros',()=>{});submit.type='submit';submit.onclick=null;
  actions.append(submit,skin.button('Limpar filtros',()=>apply('',false),true));
  const waitlist=skin.button('Lista de espera',()=>{dialog.close();C.showTab('waitlist');},true);waitlist.className='cm-waitlist-link';actions.appendChild(waitlist);
  body.append(field,closed,actions);dialog.append(header,body);
  body.onsubmit=event=>{event.preventDefault();apply(body.querySelector('[name="cm-chat-channel"]:checked').value,toggle.checked);};
  const original=ch.el('filters-button').onclick;
  skin.filters={close:()=>{if(dialog.open)dialog.close();},bind:()=>{ch.el('filters-button').onclick=()=>{
    if(!skin.active()){original?.();return;}field.querySelectorAll('input').forEach(r=>r.checked=r.value===s.channel);toggle.checked=s.closed;ch.el('filters').classList.add('hidden');dialog.showModal();ch.el('filters-button').setAttribute('aria-expanded','true');
  };}};
  dialog.addEventListener('close',()=>ch.el('filters-button').setAttribute('aria-expanded','false'));
}());
