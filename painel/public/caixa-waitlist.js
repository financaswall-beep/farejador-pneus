(function(){
  'use strict';
  const C=window.Caixa,W=window.StockWaitlist;
  const nav=document.createElement('nav');nav.className='wl-attendance-tabs hidden';nav.setAttribute('aria-label','Atendimento');
  nav.innerHTML='<button type="button" data-section="conversations">Conversas</button><button type="button" data-section="waitlist">Lista de espera</button>';
  const root=document.createElement('section');root.className='hidden';root.setAttribute('aria-label','Lista de espera');
  document.getElementById('chat-panel').before(nav,root);
  let session='';
  const view=W.create(root,{mobile:true,prefix:'/api/caixa/waitlist',assets:'/operacao',
    api:async(path,body)=>C.chat.api(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined),
    onDetail:open=>C.elements.sessionView.classList.toggle('is-waitlist-detail',open),
    onDemand:()=>{root.querySelector('.wl-demand')?.scrollIntoView({behavior:'smooth'});C.showToast('A procura nesta lista considera os clientes que autorizaram o aviso.');}});
  nav.addEventListener('click',e=>{const b=e.target.closest('[data-section]');if(b)C.showTab(b.dataset.section);});
  C.waitlist={syncTab(tab){
    const allowed=C.canModule('conversas'),active=allowed&&tab==='waitlist',attendance=allowed&&['waitlist','conversations'].includes(tab);
    const fingerprint=C.sessionFingerprint();if(session!==fingerprint){view.reset();session=fingerprint;}
    root.classList.toggle('hidden',!active);nav.classList.toggle('hidden',!attendance);
    nav.querySelectorAll('button').forEach(b=>b.classList.toggle('selected',b.dataset.section===tab));
    C.elements.sessionView.classList.toggle('is-waitlist',active);
    if(!active)C.elements.sessionView.classList.remove('is-waitlist-detail');
    const button=document.getElementById('nav-conversations');button.classList.toggle('active',attendance);button.setAttribute('aria-current',attendance?'page':'false');
    if(active){C.elements.appHeadingTitle.textContent='Lista de espera';history.replaceState(null,'',location.pathname+location.search+'#lista-de-espera');view.start();}
    else{view.stop();if(location.hash==='#lista-de-espera')history.replaceState(null,'',location.pathname+location.search+(tab==='conversations'?'#conversas':''));}
  },reset(){view.reset();root.classList.add('hidden');nav.classList.add('hidden');}};
}());
