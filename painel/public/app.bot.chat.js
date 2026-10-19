(function(){
  'use strict';
  // Adaptador da sessão do painel. O motor, a mídia e a ficha são compartilhados com o app.
  const H=window.FarejadorBotChat={
    chatPrefix:'/admin/api/bot/chat',chatMountId:'bot-chat-root',chatCustomerInline:true,
    chatAssetBase:'/admin/painel/assets',app:null,
    isAuthenticated(){return !!H.app?.adminAuthenticated&&H.app.isMatrixPanel()&&H.app.hasPanelModule('bot');},
    sessionFingerprint(){return JSON.stringify([H.app?.serverEnvironment,H.app?.adminUser?.person_id,H.app?.adminUser?.username,H.app?.adminUser?.role]);},
    async authenticatedFetch(path,options={}){
      if(!H.isAuthenticated())throw Error('missing_admin_session');
      const session=H.sessionFingerprint();
      const response=await fetch(path,{...options,credentials:'same-origin'});
      if(!H.isAuthenticated()||session!==H.sessionFingerprint())throw Error('session_changed');
      if(response.status===401){H.chat.reset();H.app.adminUnauthorized();}
      if(response.status===403){H.chat.reset();H.showToast('Seu acesso não permite abrir as conversas. Peça ao administrador para conferir sua permissão.',true);}
      return response;
    },
    json:response=>response.json(),
    showToast(message,persistent=false){
      const notice=document.getElementById('bot-chat-notice');if(!notice)return;
      notice.textContent=message;notice.hidden=false;clearTimeout(H.noticeTimer);
      if(!persistent)H.noticeTimer=setTimeout(()=>{notice.hidden=true;},6500);
    },
    canOpenStock(){return H.app?.hasPanelModule('estoque');},
    canOpenSale(){return H.app?.adminUser?.role==='owner';},
    openChatStock(){if(H.canOpenStock())H.app.currentPage='estoque';},
    async openChatSale(row,data){
      if(!H.canOpenSale())return;
      const app=H.app,session=H.sessionFingerprint();
      try{
        const products=await app.apiGet('/admin/api/dashboard/produtos?limit=100');
        if(!H.isAuthenticated()||H.sessionFingerprint()!==session)return;
        app.applyProdutos(products.rows);
        app.openSaleModal({id:row.id,chatwoot_conversation_id:row.chatwoot_conversation_id,contact_name:row.name});
        app.saleForm.customer_name=data.customer?.name||row.name||'';
        app.saleForm.customer_phone=data.customer?.phone||'';
      }catch(_){H.showToast('Não consegui consultar o estoque para a venda. Tente novamente.');}
    },
    sync(app,active){
      H.app=app;const chat=H.chat;if(!chat)return;
      if(!H.initialized)H.initialize();
      if(!H.isAuthenticated()){
        if(chat.state.session||chat.state.active)chat.reset();
        const notice=document.getElementById('bot-chat-notice');if(notice)notice.hidden=true;
        chat.el('panel').classList.add('hidden');return;
      }
      if(!active){if(chat.state.active){chat.stop();chat.resetMedia();}return;}
      if(!chat.state.active){const notice=document.getElementById('bot-chat-notice');if(notice)notice.hidden=true;}
      const starting=!chat.state.active;
      chat.start();chat.el('panel').classList.remove('hidden');if(starting)chat.renderThread();
      requestAnimationFrame(H.resize);
    },
    resize(){
      const root=document.getElementById(H.chatMountId);if(!root||!H.chat.state.active)return;
      const viewport=window.visualViewport,nav=document.getElementById('farejador-sidebar')?.getBoundingClientRect();
      let bottom=viewport?viewport.offsetTop+viewport.height:window.innerHeight;
      if(nav&&nav.width>window.innerWidth*.8&&nav.top>0)bottom=Math.min(bottom,nav.top);
      root.style.setProperty('--bot-chat-height',Math.max(300,bottom-root.getBoundingClientRect().top-16)+'px');
    },
    initialize(){
      H.initialized=true;const chat=H.chat,panel=chat.el('panel');
      const heading=document.createElement('h2');heading.textContent='Conversas';
      panel.querySelector('.chat-title').prepend(heading);
      const render=chat.renderThread;
      chat.renderThread=function(){
        render();
        panel.querySelectorAll('.chat-top-controls .chat-mode').forEach(button=>{
          const label=document.createElement('span');label.textContent=button.dataset.control==='takeover'?'Humano':'Bot';button.append(label);
        });
        const toggle=chat.el('customer');if(toggle){toggle.textContent='Ficha do cliente';toggle.setAttribute('aria-controls','chat-sheet');toggle.setAttribute('aria-expanded',String(!chat.el('sheet').hidden));}
      };
      window.addEventListener('resize',H.resize);
      window.visualViewport?.addEventListener('resize',H.resize);
      window.addEventListener('pagehide',()=>chat.reset());
    },
  };
})();
