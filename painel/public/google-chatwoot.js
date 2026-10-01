// Incluir no site, depois do SDK Chatwoot. Somente referencia consentida criada pelo Farejador.
(function(){
  const params=new URLSearchParams(location.search),ref=params.get('farejador_google_click_ref');
  if(!/^2W-G[a-f0-9]{32}$/.test(ref||''))return;
  let applied=false;
  function attach(){
    if(applied||!window.$chatwoot||typeof window.$chatwoot.setCustomAttributes!=='function')return;
    window.$chatwoot.setCustomAttributes({farejador_google_click_ref:ref});applied=true;
  }
  window.addEventListener('chatwoot:ready',attach);attach();
})();
