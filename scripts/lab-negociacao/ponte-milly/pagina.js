(() => {
  'use strict';
  // Runs in Chrome's isolated world, exclusively after the owner's click in the popup.
  if (globalThis.millyLabRelay) return globalThis.millyLabRelay.prepare();
  const normalize = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const visible = el => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const turnPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const dotRoute = /^\/dots\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}~[a-z0-9_.%-]+\/?$/i;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const contents = el => el.tagName === 'TEXTAREA' ? el.value : el.innerText;
  const request = (type, body = {}) => chrome.runtime.sendMessage({ type, ...body });
  const conversationParts = '[data-message-author-role],article,[role="article"],[role="log"],nav,aside,[role="navigation"]';
  const chatContent = '[data-message-author-role],article,[role="article"],nav,[role="navigation"]';
  const sidePane = 'aside,[role="complementary"]';
  let binding, generation = 0, running = false, stage = 'rota';

  function findTitle() {
    if (dotRoute.test(location.pathname)) {
      return normalize(document.title) === 'Milly' ? document.documentElement : null;
    }
    if (/^\/c\//.test(location.pathname)) {
      // An ordinary conversation can be renamed "Milly". Require the actual Dots profile link in the header.
      const profiles = all('header a[href],[role="banner"] a[href]').filter(el => {
        if (el.closest(conversationParts) || normalize(el.innerText || el.getAttribute('aria-label')).toLowerCase() !== 'milly') return false;
        try { const target = new URL(el.href); return target.origin === location.origin && dotRoute.test(target.pathname); }
        catch { return false; }
      });
      return profiles.length === 1 ? profiles[0] : null;
    }
    return null;
  }
  function findComposer() {
    const matches = all('textarea:not([readonly]):not([disabled]),[contenteditable="true"],[contenteditable="plaintext-only"]').filter(el => {
      if (el.closest(chatContent) || el.parentElement?.closest('[contenteditable="true"],[contenteditable="plaintext-only"]')) return false;
      if (!el.closest(sidePane)) return true;
      const hint = normalize(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder'));
      return dotRoute.test(location.pathname) && /^(?:enviar uma mensagem|send a message)[.…]*$/i.test(hint);
    });
    return matches.length === 1 ? matches[0] : null;
  }
  function samePage() {
    return !!binding && location.href === binding.url && findTitle() === binding.title && findComposer() === binding.composer;
  }
  function prepare() {
    generation++;
    running = false;
    binding = null;
    stage='rota';
    if (location.origin !== 'https://chatgpt.com' ||
        !(dotRoute.test(location.pathname) || /^\/c\/[a-f0-9-]{36}\/?$/i.test(location.pathname))) {
      return {ok:false, stage};
    }
    stage='titulo';
    const title = findTitle();
    if (!title) return {ok:false,stage};
    stage='caixa';
    const composer = findComposer();
    if (!composer) return {ok:false,stage};
    stage='rascunho';
    if (normalize(contents(composer))) return {ok:false,stage};
    binding = {title, composer, url:location.href};
    stage='pronta';return {ok:true,stage};
  }
  function sendButton() {
    // Limit the action to the composer controls. Never click buttons rendered by messages.
    let scope = binding.composer.parentElement;
    for (let i = 0; i < 6 && scope && !['MAIN','BODY','HTML'].includes(scope.tagName); i++, scope = scope.parentElement) {
      const buttons = all('button:not(:disabled)', scope).filter(btn => !btn.closest(chatContent) &&
        btn.closest(sidePane) === binding.composer.closest(sidePane) &&
        btn.getAttribute('aria-disabled') !== 'true' && (btn.dataset.testid === 'send-button' ||
        (btn.getAttribute('type') === 'submit' && btn.form === binding.composer.closest('form') && !!btn.form) ||
        (btn.querySelector('svg.lucide-arrow-up,svg[data-icon="arrow-up"],svg[data-lucide="arrow-up"]') && !normalize(btn.innerText)) ||
        /^(?:send|enviar)(?: (?:prompt|mensagem|message|consulta|pergunta))?$/i.test(normalize(btn.getAttribute('aria-label') || btn.title || btn.innerText))));
      if (buttons.length === 1) return buttons[0];
      if (buttons.length > 1) return null;
    }
    return null;
  }
  function writeDraft(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', {bubbles:true}));
    } else {
      if (!document.execCommand('insertText', false, text)) throw new Error('Caixa incompatível.');
    }
    if (normalize(contents(el)) !== normalize(text)) throw new Error('O rascunho não ficou íntegro.');
  }
  function answerNodes() {
    const pane = binding.composer.closest(sidePane);
    return all('[data-message-author-role="assistant"],[data-author-role="assistant"],[data-role="assistant"],article[aria-label],[role="article"][aria-label]', pane || document).filter(node =>
      node.closest(sidePane) === pane && ([node.dataset.messageAuthorRole,node.dataset.authorRole,node.dataset.role].includes('assistant') ||
      /^(?:milly|chatgpt|assistente|assistant)(?:\s|$)/i.test(node.getAttribute('aria-label') || '')));
  }
  function parseReply(part, turn) {
    if (!part || part.length > 2400) return null;
    const raw = part.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, '$1');
    try {
      const p = JSON.parse(raw);
      if (!p || p.turno !== turn || Object.keys(p).length !== 5 || typeof p.justificativa !== 'string' ||
          !p.justificativa.trim() || p.justificativa.length > 300 ||
          !['manter','aceitar','contrapropor','aguardar_dado'].includes(p.decisao)) return null;
      const price = p.total_centavos !== null;
      if (price && (!Number.isSafeInteger(p.total_centavos) || p.total_centavos < 1 || p.total_centavos > 2147483647)) return null;
      if (price ? !['retirada','entrega'].includes(p.modalidade) : p.modalidade !== null) return null;
      if (p.decisao === 'aguardar_dado' && price || ['aceitar','contrapropor'].includes(p.decisao) && !price) return null;
      return JSON.stringify(p);
    } catch { return null; }
  }
  function replyFor(nodes, old, turn) {
    for (const el of nodes) {
      if (old.has(el)) continue;
      const parts = [...all('pre code', el).map(code => code.textContent), el.innerText];
      for (const part of parts) {
        const parsed = parseReply(part,turn);
        if (parsed) return parsed;
      }
    }
    return null;
  }
  // Dots can render plain bubbles. Inspect only newly changed elements, and require the
  // rendered outgoing prompt before considering a subsequent, separate bubble as its reply.
  function watchBubbles(query) {
    if (typeof MutationObserver === 'undefined') return null;
    const expected = normalize(query.prompt), changed = new Set(), echoes = new Set();
    const ignored = 'nav,header,button,form,textarea,input,[contenteditable]:not([contenteditable="false"]),[role="navigation"]';
    const pane = binding.composer.closest(sidePane);
    const stopTags = ['MAIN','BODY','HTML'];
    function remember(node) {
      let el = node.nodeType === 1 ? node : node.parentElement;
      for (let n=0; n<5 && el && !stopTags.includes(el.tagName); n++,el=el.parentElement) {
        if (!el.closest(ignored) && el.closest(sidePane) === pane) changed.add(el);
        if (changed.size>160) changed.delete(changed.values().next().value);
      }
    }
    const observer = new MutationObserver(records=>{
      for (const record of records.slice(-80)) {
        if (record.type==='characterData') remember(record.target);
        for (const n of Array.from(record.addedNodes).slice(-32)) {
          remember(n);
          if (n.nodeType===1) for (const child of Array.from(n.querySelectorAll('p,pre,code,[dir="auto"]')).slice(-32)) remember(child);
        }
      }
    });
    observer.observe(pane || document.body,{subtree:true,childList:true,characterData:true});
    return {
      read() {
        const texts = [];
        for (const el of changed) {
          if (!visible(el) || el.closest(ignored) || el.childElementCount>20) continue;
          const value = el.innerText;
          if (!value || value.length>Math.max(expected.length+300,2400)) continue;
          if (normalize(value)===expected) echoes.add(el);
          else if (value.length<=2400 && value.includes(query.turno)) texts.push([el,value]);
        }
        for(const [el,value] of texts) {
          if (el.closest('[data-message-author-role="user"],[data-role="user"],[data-author-role="user"]')) continue;
          if (![...echoes].some(e => e.isConnected && !e.contains(el) && !el.contains(e) &&
            (e.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))) continue;
          const parsed=parseReply(value,query.turno);
          if (parsed) return parsed;
        }
        return null;
      },
      stop() { observer.disconnect();changed.clear();echoes.clear(); },
    };
  }
  async function exchange(query, round) {
    if (!turnPattern.test(query.turno) || typeof query.prompt !== 'string' || !query.prompt || query.prompt.length > 65000) return;
    const current = () => running && generation === round && samePage();
    let watcher;
    const composer = binding?.composer;
    const personalInput = event => { if(event.isTrusted && generation === round) running=false; };
    try {
      if (!current() || normalize(contents(binding.composer))) throw new Error('A aba mudou ou há outro rascunho.');
      const existing = new Set(answerNodes());
      stage='composicao';writeDraft(binding.composer, query.prompt);
      stage='botao';
      let button;
      for (let i=0; i<20 && current(); i++) {
        if ((button=sendButton())) break;
        await wait(100);
      }
      if (!current() || !button || normalize(contents(binding.composer)) !== normalize(query.prompt)) throw new Error('Envio indisponível.');
      // Once acknowledged a restart can never silently send the same question again.
      stage='ack_envio';const ack = await request('recebida', {turno:query.turno});
      if (!ack?.ok || !current() || sendButton() !== button || normalize(contents(binding.composer)) !== normalize(query.prompt)) throw new Error('Turno interrompido.');
      watcher = watchBubbles(query);
      composer.addEventListener('beforeinput',personalInput);
      button.click();
      stage='parecer';
      const deadline = Date.now()+120000;
      let last = null;
      while (current() && Date.now() < deadline) {
        await wait(1200);
        if (!current()) break;
        const text = replyFor(answerNodes(),existing,query.turno) || watcher?.read();
        if (text && last === text) {
          stage='ack_parecer';const saved = await request('resposta',{turno:query.turno,texto:text});
          if (!saved?.ok) throw new Error('Parecer recusado.');
          stage='pronta';
          return;
        }
        last = text;
      }
      throw new Error('A leitura terminou.');
    } catch {
      await request('erro',{turno:query.turno}).catch(() => {});
      // Leave any draft in place for the owner to review and prevent an unattended second attempt.
      if (generation === round) running = false;
    } finally { watcher?.stop();composer?.removeEventListener('beforeinput',personalInput); }
  }
  async function poll(round) {
    while (running && generation === round && samePage()) {
      try {
        if (!normalize(contents(binding.composer))) {
          const result = await request('proxima');
          if (result?.erro) break;
          if (result?.consulta) await exchange(result.consulta, round);
        }
      } catch { break; }
      await wait(2300);
    }
    if (generation === round) running=false;
  }
  chrome.runtime.onMessage.addListener((req,sender,respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (req.type === 'detach') { generation++; running=false; binding=null; respond(true); }
    else if (req.type === 'check') respond(running && samePage());
    else if (req.type === 'diagnostic') respond({active:running && samePage(),stage});
    else if (req.type === 'start') {
      if (!samePage()) { respond(false); return false; }
      running=true; generation++;
      respond(true);
      void poll(generation);
    }
    return false;
  });
  globalThis.millyLabRelay = {prepare};
  return prepare();
})();
