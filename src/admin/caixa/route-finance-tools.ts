import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerCaixaFinanceExpenseRoutes } from './route-finance-expenses.js';
import { registerCaixaFinanceReportRoutes } from './route-finance-reports.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export function registerCaixaFinanceToolRoutes(app: FastifyInstance, flag: Gate, auth: Gate, finance: Gate) {
  registerCaixaFinanceExpenseRoutes(app, flag, auth, finance);
  registerCaixaFinanceReportRoutes(app, flag, auth, finance);
}
