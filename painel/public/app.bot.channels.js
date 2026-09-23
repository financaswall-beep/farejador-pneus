(function(){
  'use strict';
  let app=null;
  const alerts=window.FarejadorChannelAlerts.create({
    active:()=>!!app?.adminAuthenticated&&app.currentPage==='bot'&&location.pathname.startsWith('/admin/painel'),
    session:()=>JSON.stringify([app?.serverEnvironment,app?.adminUser?.person_id,app?.adminUser?.username]),
    request:()=>app.apiGet('/admin/api/bot/channels'),
    targets:()=>[{element:document.getElementById('bot-channel-alerts')}],
  });
  window.FarejadorBotChannels={refresh(current){app=current;void alerts.refresh();}};
}());
