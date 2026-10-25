import type {ChatMessage} from './types.js';

/** Escopo inicial: modelo conferido na documentação e no uso real do bot. */
export const supportsStaticPromptCache=(model:string)=>/^gpt-6\.1-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(model);

/** Preserva integralmente o contexto e o histórico; separa apenas a fronteira das regras. */
export function buildAgentMessages(model:string,staticRules:string,conversationContext:string,history:ChatMessage[]):ChatMessage[]{
 if(!supportsStaticPromptCache(model))return [{role:'system',content:staticRules+conversationContext},...history];
 return [{role:'developer',content:staticRules},
  ...(conversationContext?[{role:'developer' as const,content:conversationContext}]:[]),...history];
}

export function staticPromptCache(input:Record<string,unknown>[],model:string,enabled:boolean):{
 input:Record<string,unknown>[];prompt_cache_options?:{mode:'explicit';ttl:'30m'};
}{
 const first=input[0];
 if(!enabled||!supportsStaticPromptCache(model)||first?.role!=='developer'
  ||typeof first.content!=='string'||!first.content.trim())return {input};
 return {input:[{...first,content:[{type:'input_text',text:first.content,
  prompt_cache_breakpoint:{mode:'explicit'}}]},...input.slice(1)],
  prompt_cache_options:{mode:'explicit',ttl:'30m'}};
}
