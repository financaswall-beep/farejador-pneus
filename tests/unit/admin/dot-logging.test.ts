import pino from 'pino';
import { expect, it } from 'vitest';
import { loggerOptions } from '../../../src/shared/logger.js';

it('logs HTTP não incluem parâmetros OAuth nem credenciais em objetos',()=>{
  let output='';
  const log=pino({...loggerOptions,level:'info'},{write(chunk:string){output+=chunk;}});
  log.info({req:{method:'GET',url:'/admin/dot/authorize?code=CODE-SECRET&state=STATE-SECRET&code_challenge=CHALLENGE-SECRET'},
    access_token:'ACCESS-SECRET',refresh_token:'REFRESH-SECRET',code:'CODE-SECRET',
    payload:{access_token:'ACCESS-SECRET',refresh_token:'REFRESH-SECRET',code_verifier:'VERIFIER-SECRET',request_token:'REQUEST-SECRET'}});
  expect(output).not.toMatch(/CODE-SECRET|STATE-SECRET|CHALLENGE-SECRET|ACCESS-SECRET|REFRESH-SECRET|VERIFIER-SECRET|REQUEST-SECRET/);
  expect(JSON.parse(output).req.url).toBe('/admin/dot/authorize');
  output='';
  log.info({req:{method:'GET',url:'/admin/login?dot_return=STATE-SECRET'}});
  expect(output).not.toContain('STATE-SECRET');
  expect(JSON.parse(output).req.url).toBe('/admin/login');
});
