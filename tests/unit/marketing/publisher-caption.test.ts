import {it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
vi.mock('../../../src/shared/config/env.js',()=>({env:{OPENAI_API_KEY:'secret-openai',OPENAI_MODEL:'gpt-6-sol'}}));
import {generateCaption,minimizeBrief} from '../../../src/marketing/publisher/caption.js';
it('IA produz sugestão em analytics, com proveniência e sem escrever a publicação',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{id:'caption-id'}]});
  const request=vi.fn().mockResolvedValue({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Pneus para rodar com tranquilidade.'}]}],usage:{input_tokens:20,output_tokens:12}});
  expect(await generateCaption({query} as unknown as Pool,'test','Pneus para moto, cliente teste@example.com',request)).toMatchObject({requires_review:true});
  const body=JSON.parse(request.mock.calls[0]![0]);expect(body.store).toBe(false);expect(body.input).not.toContain('teste@example.com');expect(body).not.toHaveProperty('tools');
  expect(query).toHaveBeenCalledOnce();expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO analytics.publisher_captions');
  expect(query.mock.calls[0]?.[1]).toEqual(['test','Pneus para moto, cliente [email omitido]','Pneus para rodar com tranquilidade.','publisher-caption-v1','gpt-6-sol',20,12]);
});
it('não salva texto recusado, incompleto ou fora do limite',async()=>{
  const query=vi.fn();const request=vi.fn().mockResolvedValue({status:'incomplete',output:[]});
  await expect(generateCaption({query} as unknown as Pool,'test','Pneus',request)).rejects.toThrow('publisher_ai_response_invalid');
  expect(query).not.toHaveBeenCalled();expect(minimizeBrief('CPF 123.456.789-00, (21) 99999-1234')).not.toMatch(/123\.456|99999/);
});
