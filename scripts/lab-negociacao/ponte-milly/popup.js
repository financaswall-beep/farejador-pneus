'use strict';
const statusLine = document.querySelector('#status');
const targetTab=Number(new URL(location.href).searchParams.get('aba'));
const stages={rota:'Verificação do endereço',titulo:'Identificação da Milly',caixa:'Caixa de mensagem',rascunho:'Rascunho existente',
  pronta:'Pronta para o laboratório',composicao:'Composição da pergunta',botao:'Botão de envio',ack_envio:'Confirmação de envio',
  parecer:'Aguardando parecer',ack_parecer:'Confirmação do parecer no laboratório'};
async function run(action) {
  try {
    const result = await action();
    statusLine.textContent = result.message;
    document.querySelector('#target').textContent = result.target ?? '';
    document.querySelector('#stage').textContent = stages[result.stage] ?? '';
    document.querySelector('#stop').hidden = !result.connected;
    document.querySelector('#pair').hidden = !result.ready || !!result.connected;
  } catch { statusLine.textContent = 'Abra o pareamento novamente pelo ícone da extensão na aba da Milly.'; }
}
document.querySelector('#pair').addEventListener('submit', event => {
  event.preventDefault();
  const codeInput = document.querySelector('#code');
  const token = codeInput.value.trim();
  codeInput.value = '';
  run(() => chrome.runtime.sendMessage({ type:'pair', tabId:targetTab, token }));
});
document.querySelector('#stop').addEventListener('click', () => run(() => chrome.runtime.sendMessage({ type:'stop' })));
document.querySelector('#refresh').addEventListener('click', () => run(() => chrome.runtime.sendMessage({ type:'status' })));
run(() => chrome.runtime.sendMessage({ type:'status' }));
