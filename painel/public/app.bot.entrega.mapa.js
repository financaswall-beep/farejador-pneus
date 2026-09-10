window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botEntregaMapa = function () {
  let map=null,circle=null,markers=[],loading=null;
  async function load(key){
    if(window.google?.maps?.Map)return;
    if(loading)return loading;
    loading=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      window.farejadorDeliveryMapsReady=()=>{delete window.farejadorDeliveryMapsReady;resolve();};
      script.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(key)+'&loading=async&callback=farejadorDeliveryMapsReady&v=quarterly';
      script.async=true;script.referrerPolicy='strict-origin-when-cross-origin';
      script.onerror=()=>{script.remove();loading=null;reject(new Error('maps_load_failed'));};
      document.head.appendChild(script);
    });
    return loading;
  }
  return {
    botEntregaMapaErro:'',botEntregaMapaPronto:false,
    async botEntregaMapaAtualizar(){
      const config=this.botEntregaConfig;if(!config)return;
      this.botEntregaMapaErro='';
      if(!config.maps_browser_key){this.botEntregaMapaErro='O mapa do Google será exibido após configurar a chave de mapas do painel. O cadastro e a simulação continuam disponíveis.';return;}
      try{
        await load(config.maps_browser_key);
        const host=document.getElementById('bot-entrega-map');if(!host)return;
        const origin={lat:this.botEntregaForm.latitude,lng:this.botEntregaForm.longitude};
        if(!map)map=new google.maps.Map(host,{center:origin,zoom:12,mapTypeControl:false,streetViewControl:false,fullscreenControl:false});
        markers.forEach(m=>m.setMap(null));markers=[];if(circle)circle.setMap(null);
        const marker=(position,title,label)=>markers.push(new google.maps.Marker({map,position,title,label}));
        marker(origin,'Matriz','M');
        circle=new google.maps.Circle({map,center:origin,radius:Number(this.botEntregaForm.radius_km||0)*1000,
          strokeColor:'#086657',strokeOpacity:.8,strokeWeight:2,fillColor:'#94dc76',fillOpacity:.18});
        const result=this.botEntregaResult;
        if(result&&!this.botEntregaStale){
          marker(result.location,'Cliente','C');
          result.diagnostics.filter(d=>d.unitId!=='matriz'&&d.location).forEach(d=>marker(d.location,d.name,d.selected?'✓':'P'));
          const bounds=new google.maps.LatLngBounds();bounds.extend(origin);bounds.extend(result.location);
          result.diagnostics.filter(d=>d.selected&&d.location).forEach(d=>bounds.extend(d.location));
          map.fitBounds(bounds,60);
        }else{map.setCenter(origin);if(this.botEntregaForm.radius_km)map.fitBounds(circle.getBounds());}
        this.botEntregaMapaPronto=true;
      }catch(_){this.botEntregaMapaErro='Não foi possível carregar o Google Maps. Confira a conexão e a configuração da chave.';}
    },
  };
};
