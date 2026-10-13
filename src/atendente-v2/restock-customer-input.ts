import {normalizeCheckoutPhone} from '../shared/phone.js';

/** Usa apenas número completo escrito pelo cliente; não lê respostas do bot nem completa dígitos. */
export function explicitRestockPhone(messages:Array<{content:unknown;sent_at:unknown}>):string|null|undefined {
  for(const message of messages) {
    const sentAt=new Date(String(message.sent_at)).getTime();
    if(!Number.isFinite(sentAt)||Date.now()-sentAt>30*60000)continue;
    const text=String(message.content??'');
    const whole=normalizeCheckoutPhone(text);
    if(whole)return whole;
    if(!/whats|telefone|celular|meu n[uú]mero|ddd/i.test(text))continue;
    const numbers=new Set<string>();
    const candidates=[...text.matchAll(/(?<!\d)(?:\+?55[\s().-]*)?\(?[1-9]\d\)?[\s.-]*[2-9]\d{3,4}[\s.-]*\d{4}(?!\d)/g)];
    for(const match of candidates){const phone=normalizeCheckoutPhone(match[0]);if(phone)numbers.add(phone);}
    if(candidates.length)return numbers.size===1?[...numbers][0]!:null;
  }
  return undefined;
}
