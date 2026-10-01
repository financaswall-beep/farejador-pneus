(async function(){
  const status=document.getElementById('status'),params=new URLSearchParams(location.search);
  const identifierType=['gclid','gbraid','wbraid'].find(type=>/^[A-Za-z0-9_-]{1,512}$/.test(params.get(type)||''));
  const id=key=>/^\d{1,30}$/.test(params.get(key)||'')?params.get(key):null;
  const campaign=id('campaignid'),group=id('adgroupid'),ad=id('creative');
  const canMeasure=!!identifierType&&!!campaign&&!!group&&!!ad;
  document.getElementById('measure').disabled=!canMeasure;
  try {
    const response=await fetch('/marketing/google/contact-config',{cache:'no-store'});
    if(!response.ok)throw new Error();
    const config=await response.json();
    for(const destination of ['whatsapp','web']){
      const button=document.getElementById(destination);button.disabled=!(destination==='web'?config.website:config.whatsapp);
      button.addEventListener('click',async()=>{
        button.disabled=true;status.textContent='Abrindo atendimento…';
        const measurement=canMeasure&&document.getElementById('measure').checked;
        try {
          const res=await fetch('/marketing/google/contact',{method:'POST',headers:{'Content-Type':'application/json','X-Farejador-Contact':'1'},
            body:JSON.stringify({destination,measurement,...(measurement?{click:{campaign_id:campaign,ad_group_id:group,ad_id:ad,
              identifier_type:identifierType,identifier:params.get(identifierType),consent_ad_user_data:true,consent_ad_personalization:false,destination}}:{})})});
          if(!res.ok)throw new Error();const result=await res.json();const url=new URL(result.url);
          if(url.protocol!=='https:')throw new Error();location.assign(url.href);
        }catch{status.textContent='Não foi possível abrir o atendimento. Tente novamente.';button.disabled=false;}
      });
    }
    if(!config.website&&!config.whatsapp)status.textContent='Os canais de atendimento ainda estão sendo configurados.';
  }catch{status.textContent='Atendimento temporariamente indisponível. Atualize a página.';}
})();
