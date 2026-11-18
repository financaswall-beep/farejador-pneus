'use strict';
const endpoint = 'http://127.0.0.1:4328/api/ponte/';
const getBinding = async () => (await chrome.storage.session.get('binding')).binding;
const popup = chrome.runtime.getURL('popup.html');
const stopped = message => ({ connected:false, message });
const running = message => ({ connected:true, message });
const actions = new Set(['proxima', 'recebida', 'resposta', 'erro']);
const validTurn = turn => typeof turn === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(turn);
const invitationKey = pageTab => 'pairingPage:' + pageTab;
const stages = new Set(['rota','titulo','caixa','rascunho','pronta','composicao','botao','ack_envio','parecer','ack_parecer']);
const safeStage = value => stages.has(value) ? value : 'rota';

function isDot(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://chatgpt.com' &&
      (/^\/dots\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}~[a-z0-9_.%-]+\/?$/i.test(u.pathname) ||
       /^\/c\/[a-f0-9-]{36}\/?$/i.test(u.pathname));
  } catch { return false; }
}
async function forget(binding) {
  await chrome.storage.session.remove('binding');
  if (binding) await chrome.tabs.sendMessage(binding.tabId, {type:'detach'}, {documentId:binding.documentId}).catch(() => {});
}
async function verifyTarget(tab, previous) {
  if (!isDot(tab.url)) return {stage:'rota'};
  if (previous?.tabId===tab.id && previous.url===tab.url &&
      await chrome.tabs.sendMessage(tab.id,{type:'check'},{documentId:previous.documentId}).catch(()=>false)) return {documentId:previous.documentId,stage:'pronta'};
  const [probe] = await chrome.scripting.executeScript({target:{tabId:tab.id},files:['pagina.js']});
  return {documentId:probe?.result?.ok ? probe.documentId : null,stage:safeStage(probe?.result?.stage)};
}
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  let probe={stage:'rota'};
  try { probe = await verifyTarget(tab,await getBinding()); } catch { /* Show only an operational stage below. */ }
  const page=await chrome.tabs.create({url:'about:blank',active:false});
  const key=invitationKey(page.id);
  await chrome.storage.session.set({[key]:{tabId:tab.id,url:probe.documentId?tab.url:null,...probe}});
  await chrome.tabs.update(page.id,{url:popup+'?aba='+tab.id,active:true});
});
async function handlePopup(req,sender) {
  const targetParam=new URL(sender.url).searchParams.get('aba'),key=invitationKey(sender.tab?.id);
  const selected=(await chrome.storage.session.get(key))[key];
  if (sender.frameId!==0 || !selected?.documentId || !targetParam || String(selected.tabId)!==targetParam) {
    return {...stopped('Abra a conversa individual da Milly e clique no ícone da extensão naquela aba.'),stage:safeStage(selected?.stage)};
  }
  const tab=await chrome.tabs.get(selected.tabId).catch(()=>null);
  if (tab?.url!==selected.url) return stopped('A conversa selecionada mudou. Clique no ícone da extensão na aba da Milly novamente.');
  const target='Milly · chatgpt.com · aba '+selected.tabId;
  const ready=message=>({connected:false,ready:true,target,message,stage:'pronta'});
  const old = await getBinding();
  if (req.type === 'stop') {
    if (old?.tabId===selected.tabId) await forget(old);
    return ready('Ponte desconectada.');
  }
  if (req.type === 'status') {
    if (!old || old.tabId!==selected.tabId) return ready('Destino conferido. Você pode colar o código do laboratório.');
    const diagnostic = await chrome.tabs.sendMessage(old.tabId, {type:'diagnostic'}, {documentId:old.documentId}).catch(() => null);
    if (diagnostic?.active) return {...running('Aba conectada. Você pode voltar ao laboratório.'),target,stage:safeStage(diagnostic.stage)};
    await forget(old);
    return {...stopped('Ponte interrompida. Confira a etapa e abra o pareamento novamente.'),stage:safeStage(diagnostic?.stage)};
  }
  if (req.type!=='pair' || req.tabId!==selected.tabId || typeof req.token!=='string' ||
      !/^[a-zA-Z0-9_-]{24,192}$/.test(req.token)) return ready('Confira o código de pareamento copiado do laboratório.');
  const confirmed=await verifyTarget(tab,old);
  if (!isDot(tab.url) || confirmed.documentId!==selected.documentId) {
    return {...stopped('O documento da Milly mudou. Abra o pareamento novamente.'),stage:safeStage(confirmed.stage)};
  }
  if (old && (old.tabId!==selected.tabId || old.documentId!==selected.documentId)) await forget(old);
  const binding = { tabId:selected.tabId, documentId:selected.documentId, url:tab.url, token:req.token };
  await chrome.storage.session.set({ binding });
  const ok = await chrome.tabs.sendMessage(binding.tabId, {type:'start'}, {documentId:binding.documentId}).catch(() => false);
  if (!ok) { await forget(binding); return stopped('A conversa mudou durante a conexão. Tente novamente.'); }
  return {...running('Aba conectada. Você pode voltar ao laboratório.'),target};
}
async function handlePage(req, sender) {
  const binding = await getBinding();
  if (!binding || sender.tab?.id !== binding.tabId || sender.documentId !== binding.documentId ||
      sender.frameId !== 0 || sender.url !== binding.url || !isDot(sender.url)) return { erro:'Aba fora do pareamento.' };
  if (!actions.has(req.type)) return { erro:'Ação inválida.' };
  const body = {};
  if (req.type !== 'proxima') {
    if (!validTurn(req.turno)) return { erro:'Turno inválido.' };
    body.turno = req.turno;
  }
  if (req.type === 'resposta') {
    if (typeof req.texto !== 'string' || req.texto.length > 8000) return { erro:'Resposta inválida.' };
    body.texto = req.texto;
  }
  const response = await fetch(endpoint + req.type, {
    method:'POST', body:JSON.stringify(body), signal:AbortSignal.timeout(req.type === 'resposta' ? 150000 : 6500), credentials:'omit',
    redirect:'error', cache:'no-store', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + binding.token},
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) await forget(binding);
    return { erro:response.status === 409 ? 'Turno já atendido ou indisponível.' : 'Laboratório indisponível ou código expirado.' };
  }
  return response.json();
}
chrome.runtime.onMessage.addListener((req,sender,respond) => {
  if (sender.id !== chrome.runtime.id || !req || typeof req !== 'object') return false;
  const isPairPage = typeof sender.url==='string' && sender.url.startsWith(popup+'?') && !!sender.tab;
  const task = isPairPage ? handlePopup(req,sender) : handlePage(req,sender);
  task.then(respond, () => respond(isPairPage ? stopped('Não foi possível confirmar a aba selecionada.') : {erro:'Laboratório indisponível.'}));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => {
  await chrome.storage.session.remove(invitationKey(tabId));
  if ((await getBinding())?.tabId === tabId) await chrome.storage.session.remove('binding');
});
