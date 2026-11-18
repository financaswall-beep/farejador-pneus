// Carregar o V2 somente depois de isolar os destinos de banco, Chatwoot e workers.
import { register } from 'tsx/esm/api';

Object.assign(process.env, {
  NODE_ENV:'test', FAREJADOR_ENV:'test', DATABASE_URL:'postgres://127.0.0.1:1/lab_inerte',
  DATABASE_SSL:'false', CHATWOOT_HMAC_SECRET:'sintetico', ADMIN_AUTH_TOKEN:'sintetico',
  CHATWOOT_API_BASE_URL:'http://127.0.0.1:1', AGENT_V2_WORKER_ENABLED:'false',
  OPENAI_MODEL:process.env.OPENAI_MODEL || 'gpt-6.1-sol',
});
delete process.env.CHATWOOT_API_TOKEN;
delete process.env.PARTNER_DATABASE_URL;
register();
const { iniciar } = await import('./servidor.ts');
await iniciar();
