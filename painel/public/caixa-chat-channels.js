(function(){
  'use strict';
  const ch=window.Caixa.chat,s=ch.state;
  ch.channels=window.FarejadorChannelAlerts.create({
    active:()=>s.active,session:()=>s.session,
    request:()=>ch.api('/api/caixa/chat/channels'),
    targets:()=>{
      const row=s.detail||s.rows.find(r=>r.id===s.id);
      return [{element:ch.el('channel-alerts')},{element:ch.el('channel-warning'),inboxId:row?.chatwoot_inbox_id||-1}];
    },
  });
}());
