import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { dotEnvShape } from '../../../src/shared/config/env-dot.js';

const compose=readFileSync('docker-compose.farejador.coolify.yaml','utf8');
function composeEnv(config:Record<string,string>={}) {
  return Object.fromEntries(Object.keys(dotEnvShape).map(key=>{
    const match=compose.match(new RegExp('^ {6}'+key+': \\$\\{'+key+':-([^}]*)\\}$','m'));
    expect(match,key).toBeTruthy();
    return [key,config[key]||match![1]];
  }));
}
it('Compose sem configuração inicia com Dot desativado e aceita origem vazia',()=>{
  expect(z.object(dotEnvShape).parse(composeEnv())).toMatchObject({DOT_MCP_ENABLED:false,
    DOT_MCP_PUBLIC_ORIGIN:undefined,DOT_MCP_CLIENT_ID:'farejador-dot'});
});
it('Compose repassa a ativação e a origem configuradas no Coolify',()=>{
  expect(z.object(dotEnvShape).parse(composeEnv({DOT_MCP_ENABLED:'true',DOT_MCP_PUBLIC_ORIGIN:'https://farejador.example'})))
    .toMatchObject({DOT_MCP_ENABLED:true,DOT_MCP_PUBLIC_ORIGIN:'https://farejador.example'});
});
