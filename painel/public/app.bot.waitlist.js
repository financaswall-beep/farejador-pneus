window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.botWaitlist=function(){
  let view;
  return {
    syncBotWaitlist(active){
      if(!this.adminAuthenticated){view?.reset();view=undefined;return;}
      if(!active){view?.stop();return;}
      if(!view)view=window.StockWaitlist.create(document.getElementById('bot-waitlist'),{
        prefix:'/admin/api/bot/waitlist',assets:'/admin/painel/assets',metal:true,
        api:(path,body)=>body?this.apiPost(path,body):this.apiGet(path),onDemand:()=>{this.botTab='demanda';}});
      view.start();
    },
    refreshBotWaitlist(){return view?.refresh();},
    exportBotWaitlist(){return view?.exportCsv();},
  };
};
