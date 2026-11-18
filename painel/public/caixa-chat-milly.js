(function () {
  'use strict';
  const C=window.FarejadorBotChat||window.Caixa, ch=C.chat,s=ch.state,view=ch.millyView;
  const panel=ch.el('panel'),analysis=ch.el('milly-analysis'),tabs=ch.el('milly-tabs'),filter=ch.el('milly-filter');
  let active=null,seq=0,controller=null,lastPaint='';
  function canRead(){
    if(!s.active||!s.session||s.session!==C.sessionFingerprint())return false;
    if(C.chatMountId)return C.isAuthenticated()&&C.app.adminUser?.role==='owner'&&C.app.adminUser?.auth_type==='session';
    return !!C.token()&&C.scope()==='matrix'&&C.stored(C.keys.role)==='owner'&&C.canModule('conversas')&&C.canModule('vendas');
  }
  function canStock(){return C.chatMountId?!!C.canOpenStock?.():C.canModule('estoque');}
  function cancel(){seq++;controller?.abort();controller=null;}
  function showMode(open){
    panel.classList.toggle('milly-open',open);analysis.hidden=!open;
    ch.el('public-tab').setAttribute('aria-pressed',String(!open));
    ch.el('milly-tab').setAttribute('aria-pressed',String(open));
  }
  function reset(){
    cancel();active=null;lastPaint='';analysis.replaceChildren();analysis.scrollTop=0;analysis.removeAttribute('aria-busy');
    showMode(false);filter.hidden=true;tabs.hidden=true;
  }
  function stateForCurrent(){return {id:s.id,session:s.session,generation:s.generation,open:false,turns:[],selected:null,opened:null,
    next:null,pageCount:1,loading:false,olderPending:false,orderOpen:false,factsOpen:false,fetched:0,error:''};}
  function current(target){return target===active&&target.id===s.id&&target.generation===s.generation&&target.session===s.session&&canRead();}
  function paint(){
    if(!active?.open||!current(active))return;
    const content=view.html(active,canStock());if(lastPaint===content)return;
    const focused=document.activeElement,focusKey=analysis.contains(focused)&&focused.tagName==='BUTTON'?
      ['millyTurn','millyOrder','millyStock','millyOlder','millyRetry'].find(k=>k in focused.dataset):null;
    const previousScroll=analysis.scrollTop;analysis.innerHTML=content;lastPaint=content;analysis.scrollTop=previousScroll;
    if(focusKey){const btn=[...analysis.querySelectorAll('button')].find(b=>b.dataset[focusKey]===focused.dataset[focusKey]&&b.getClientRects().length);
      btn?.focus({preventScroll:true});}
  }
  function defaultTurn(turns){
    return [...turns].reverse().find(t=>t.consulta)||turns.at(-1);
  }
  function merge(first,second){return [...new Map([...first,...second].map(t=>[t.id,t])).values()];}
  async function load(older=false){
    const target=active;
    if(!target?.open||!current(target)||target.loading||(older&&!target.next))return;
    target.loading=true;target.olderPending=older;target.error='';target.fetched=Date.now();
    const serial=++seq;controller=new AbortController();const signal=controller.signal;
    let timer;
    const valid=()=>serial===seq&&current(target)&&target.open;
    analysis.setAttribute('aria-busy','true');if(!target.turns.length||older)paint();
    try {
      let cursor=older?target.next:null,turns=older?target.turns:[],pages=older?target.pageCount:0;
      const through=older?target.pageCount+1:target.pageCount;
      do {
        const params=cursor?'?'+new URLSearchParams({at:cursor.at,before:cursor.id}):'';
        timer=setTimeout(()=>{if(serial===seq)controller?.abort();},20000);
        const data=await ch.api(ch.path(target.id)+'/milly'+params,{signal,cache:'no-store'});clearTimeout(timer);
        if(!valid())return;
        turns=merge(data.turns,turns);cursor=data.next||null;pages++;
      } while(cursor&&pages<through);
      target.turns=turns;target.next=cursor;target.pageCount=pages;
      if(!target.selected||!turns.some(t=>t.id===target.selected)){
        const chosen=defaultTurn(turns);target.selected=chosen?.id||null;target.opened=target.selected;
        target.orderOpen=false;target.factsOpen=false;
      }
    } catch(error) {
      if(!valid())return;
      if(error.status===401||error.status===403){reset();return;}
      if(error.status===404)target.turns=[];
      target.error=error.status===404?'Esta conversa está indisponível.':'Não foi possível atualizar o histórico. Confira a conexão e tente novamente.';
    } finally {
      clearTimeout(timer);
      if(valid()){target.loading=false;target.olderPending=false;controller=null;analysis.setAttribute('aria-busy','false');paint();}
    }
  }
  function setMode(open){
    if(!active||!current(active))return;
    if(!open){
      cancel();active=stateForCurrent();analysis.replaceChildren();lastPaint='';analysis.removeAttribute('aria-busy');analysis.scrollTop=0;
    }
    active.open=open;showMode(open);if(open)void load();
  }
  function sync(){
    const allowed=canRead();
    if(!allowed){
      if(active||!filter.hidden)reset();
      if(s.filter==='milly'){s.filter='all';ch.changeFilter();}
      return;
    }
    if(active&&(active.id!==s.id||active.generation!==s.generation||active.session!==s.session))reset();
    filter.hidden=false;tabs.hidden=!s.id;
    if(!s.id)return;
    if(!active){active=stateForCurrent();if(s.filter==='milly')setMode(true);}
    else if(active.open&&active.pageCount===1&&!document.hidden&&!active.loading&&Date.now()-active.fetched>=10000)void load();
  }
  panel.addEventListener('click',event=>{
    const btn=event.target.closest('button');if(!btn||!canRead())return;
    if(btn===filter){sync();if(active&&!active.open)setMode(true);return;}
    if(btn===ch.el('public-tab')||btn===ch.el('milly-tab')){setMode(btn===ch.el('milly-tab'));return;}
    if(!active?.open||!current(active))return;
    if(btn.id==='chat-refresh'||btn.hasAttribute('data-milly-retry'))void load();
    else if(btn.hasAttribute('data-milly-older'))void load(true);
    else if(btn.dataset.millyTurn){
      const id=btn.dataset.millyTurn;if(!active.turns.some(t=>t.id===id))return;
      if(active.selected!==id){active.orderOpen=false;active.factsOpen=false;}
      active.selected=id;active.opened=active.opened===id?null:id;paint();
    } else if(btn.hasAttribute('data-milly-order')){
      active.orderOpen=!active.orderOpen;paint();
    } else if(btn.hasAttribute('data-milly-stock')&&canStock()){
      const measure=active.turns.find(t=>t.id===active.selected)?.consulta?.ficha?.medida||'';
      if(C.chatMountId)C.openChatStock({measure});else {C.showTab('stock');C.matrixStock?.searchMeasure(measure);}
    }
  });
  analysis.addEventListener('toggle',event=>{
    if(active?.open&&event.target.matches('.mh-mobile-facts'))active.factsOpen=event.target.open;
  },true);
  ch.milly={sync,reset};
}());
