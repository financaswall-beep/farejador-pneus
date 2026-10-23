import { expect,it,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{DATABASE_POOL_MAX:10}}));
import { acquireDotRequest } from '../../../src/admin/dot/request-limit.js';
it('limita simultâneas por conexão e reserva capacidade global, liberando uma única vez',()=>{
  const a=acquireDotRequest('a')!,b=acquireDotRequest('a')!,c=acquireDotRequest('b')!;
  expect(acquireDotRequest('a')).toBeNull();expect(acquireDotRequest('c')).toBeNull();
  a();a();
  const d=acquireDotRequest('c');expect(d).toBeTypeOf('function');
  b();c();d!();
});
