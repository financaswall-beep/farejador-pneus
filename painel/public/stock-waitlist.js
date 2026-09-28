(function(){
  'use strict';
  const W=window.StockWaitlist;
  W.create=function(root,options){
    const s={data:null,detail:null,search:'',vehicle:'',region:'',status:'all',offset:0,filters:false,busy:false,
      avatars:new Map(),drafts:new Map(),assets:options.assets,seq:0,active:false,selected:false,epoch:0,demandAll:false};
    let timer,debounce;const api=(path='',body)=>options.api(options.prefix+path,body);
    root.classList.add('stock-waitlist');if(options.mobile)root.classList.add('wl-app');
    const notice=document.createElement('div');notice.className='wl-notice';notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');root.before(notice);
    const error=e=>({waitlist_conflict:'Este interesse foi alterado. Atualize a lista antes de tentar novamente.',
      waitlist_unavailable:'Não foi possível consultar a lista de espera. Tente atualizar novamente.',
      forbidden:'Seu acesso não permite consultar os dados dos clientes.'}[e.message]||'Não foi possível concluir. Tente novamente.');
    function message(text){notice.textContent=text;notice.hidden=!text;}
    function render(){
      const focused=root.contains(document.activeElement)?document.activeElement:null;
      const kind=focused?.hasAttribute('data-wl-search')?'search':focused?.hasAttribute('data-wl-draft')?'draft':null;
      const cursor=focused?.selectionStart;
      root.innerHTML=W.render(s);
      if(kind){const next=root.querySelector('[data-wl-'+kind+']');next?.focus();if(cursor!=null&&next?.type!=='search')next?.setSelectionRange(cursor,cursor);}
      root.querySelectorAll('img').forEach(img=>img.onerror=()=>img.remove());
      options.onDetail?.(!!s.detail);void avatars();
    }
    async function avatars(){
      const epoch=s.epoch,ids=[...new Set([s.detail?.id,...s.data.rows.map(r=>r.id)].filter(Boolean))];
      for(const id of ids){if(!s.active||s.avatars.has(id))continue;s.avatars.set(id,null);
        try{const result=await api('/'+id+'/avatar');if(!s.active||s.epoch!==epoch)return;const url=W.safeUrl(result.url);s.avatars.set(id,url);
          if(url)root.querySelectorAll('[data-wl-avatar]').forEach(node=>{if(node.dataset.wlAvatar!==id)return;const img=new Image();img.alt='';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();img.src=url;node.append(img);});
        }catch{/* As iniciais continuam disponíveis quando não há foto. */}
      }
    }
    const query=offset=>'?'+new URLSearchParams({search:s.search,vehicle:s.vehicle,region:s.region,status:s.status,offset:String(offset??s.offset)});
    async function load(silent=false){
      if(!s.active)return;const seq=++s.seq;
      if(!s.data)root.innerHTML='<div class="wl-card wl-empty" role="status">Carregando lista de espera…</div>';
      try{const data=await api(query());if(seq!==s.seq||!s.active)return;s.data=data;
        if(data.total&&s.offset>=data.total){s.offset=0;return load();}
        if(s.detail){const current=await api('/'+s.detail.id);if(seq!==s.seq||!s.active)return;s.detail=current;}
        else if(!options.mobile&&!s.selected&&data.rows.length)s.detail=data.rows[0];
        if(!silent)message('');render();
      }catch(e){if(seq!==s.seq||!s.active)return;message(error(e));if(!s.data)root.innerHTML='<div class="wl-card wl-empty"><p>Não foi possível carregar os interesses.</p><button data-wl="refresh">Tentar novamente</button></div>';}
    }
    async function select(id){const seq=++s.seq;s.selected=true;message('');try{const detail=await api('/'+id);
      if(seq!==s.seq||!s.active)return;s.detail=detail;render();if(options.mobile)root.scrollIntoView({block:'start'});
    }catch(e){message(error(e));}}
    async function change(status){if(!s.detail||s.busy)return;
      const r=s.detail,text=status==='contacted'?'Você já enviou o aviso para este cliente pelo WhatsApp?':'Marcar que este cliente não precisa mais deste pneu?';
      if(!window.confirm(text))return;s.busy=true;render();
      try{await api('/'+r.id,{version:r.version,status});s.detail=null;s.selected=true;await load();message(status==='contacted'?'Aviso registrado.':'Interesse encerrado.');}
      catch(e){message(error(e));}finally{s.busy=false;if(s.data&&s.active)render();}
    }
    async function open(){if(!s.detail||s.busy)return;const id=s.detail.id;s.busy=true;
      // Abre sincronamente ao toque para evitar bloqueio de popup; nunca envia uma mensagem.
      const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;
      try{const row=await api('/'+id);if(!s.active||s.detail?.id!==id){popup?.close();return;}s.detail=row;
        if(!row.available||row.status!=='pending'){popup?.close();message('O saldo mudou. Confira o estoque antes de oferecer.');return;}
        const text=(s.drafts.get(id)??W.suggestion(row)).trim();if(!text){popup?.close();message('Escreva a mensagem antes de abrir o WhatsApp.');return;}
        const url='https://wa.me/'+row.phone_e164.replace(/\D/g,'')+'?text='+encodeURIComponent(text);
        if(popup)popup.location.replace(url);else {message('Seu navegador bloqueou a nova aba. Permita pop-ups e tente novamente.');return;}
        message('WhatsApp aberto. Depois de enviar, toque em “marcar como avisado”.');
      }catch(e){popup?.close();message(error(e));}finally{s.busy=false;if(s.active)render();}
    }
    async function exportCsv(){if(s.busy)return;s.busy=true;message('Preparando exportação…');
      try{const rows=[];for(let offset=0;offset<10000;offset+=12){const page=await api(query(offset));rows.push(...page.rows);if(rows.length>=page.total)break;}
        const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replace(/"/g,'""')+'"';
        const csv=[['Cliente','Pneu','Veículo','Condição','Quantidade','Região','Situação','WhatsApp','Autorizado em'],...rows.map(r=>[r.name,r.measure,W.type(r),W.condition(r),r.quantity,r.city,W.stateLabel(r),W.phone(r.phone_e164),r.consent_at])].map(r=>r.map(cell).join(';')).join('\r\n');
        const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='lista-de-espera.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message('Lista exportada.');
      }catch(e){message(error(e));}finally{s.busy=false;}
    }
    root.addEventListener('input',e=>{if(e.target.matches('[data-wl-draft]')&&s.detail)s.drafts.set(s.detail.id,e.target.value);
      if(e.target.matches('[data-wl-search]')){s.search=e.target.value;s.offset=0;clearTimeout(debounce);debounce=setTimeout(()=>load(),300);}});
    root.addEventListener('change',e=>{for(const key of ['vehicle','region','status'])if(e.target.hasAttribute('data-wl-'+key)){s[key]=e.target.value;s.offset=0;void load();}});
    root.addEventListener('click',e=>{const b=e.target.closest('[data-wl]');if(!b||b.disabled)return;
      const action=b.dataset.wl;
      if(action==='select')void select(b.dataset.id);
      if(action==='back'){s.detail=null;s.selected=true;render();}
      if(action==='filters'){s.filters=!s.filters;render();}
      if(action==='filter'){s.status=b.dataset.value;s.offset=0;void load();}
      if(action==='prev'||action==='next'){s.offset=Math.max(0,s.offset+(action==='prev'?-12:12));void load();}
      if(action==='demand'){if(options.mobile){s.demandAll=!s.demandAll;render();}else options.onDemand();}
      if(action==='edit')root.querySelector('[data-wl-draft]')?.focus();
      if(action==='refresh')void load();
      if(action==='open')void open();
      if(action==='contacted'||action==='cancelled')void change(action);
    });
    return {start(){if(s.active)return;s.active=true;notice.hidden=!notice.textContent;void load();timer=setInterval(()=>{if(!document.hidden&&!s.busy&&!root.querySelector('textarea:focus'))void load(true);},30000);},
      stop(){s.active=false;s.seq++;clearInterval(timer);clearTimeout(debounce);notice.hidden=true;},
      reset(){this.stop();s.epoch++;s.data=null;s.detail=null;s.avatars.clear();s.drafts.clear();s.search='';s.vehicle='';s.region='';s.status='all';s.offset=0;s.selected=false;root.innerHTML='';message('');},refresh:load,exportCsv};
  };
}());
