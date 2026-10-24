import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { salesReportQuery } from '../painel/sales-report-period.js';
import { purchaseReportQuery } from '../painel/purchase-report-period.js';
import { stockReportQuery } from '../painel/stock-report-filter.js';
import { financialReportQuery } from '../painel/financial-report-filter.js';
import { logisticsReportQuery } from '../painel/logistics-report-filter.js';
import { partnerReportQuery } from '../painel/partner-report-filter.js';
import { demandReportQuery } from '../painel/demand-report-filter.js';
import { shortageReportQuery } from '../painel/shortage-report-filter.js';
import { getSalesReport } from '../painel/queries-sales-report.js';
import { getPurchaseReport } from '../painel/queries-purchase-report.js';
import { getStockReport } from '../painel/queries-stock-report.js';
import { getLogisticsReport } from '../painel/queries-logistics-report.js';
import { buildFinancialReport } from '../painel/queries-financial-report.js';
import { readFinancialSnapshot } from '../painel/financial-report-data.js';
import { buildPartnerReport } from '../painel/queries-partner-report.js';
import { readPartnerSnapshot } from '../painel/partner-report-data.js';
import { buildDemandReport } from '../painel/queries-demand-report.js';
import { readDemandSnapshot } from '../painel/demand-report-data.js';
import { buildShortageReport } from '../painel/queries-shortage-report.js';
import { readShortageSnapshot } from '../painel/shortage-report-data.js';
import { reportSnapshotPool } from './report-snapshot.js';
import { dotChatwootAccount } from './chat-scope.js';

export const fullReportSchemas={vendas:salesReportQuery,compras:purchaseReportQuery,estoque:stockReportQuery,
  financeiro:financialReportQuery,logistica:logisticsReportQuery,parceiros:partnerReportQuery,demanda:demandReportQuery,faltas:shortageReportQuery};
export type FullReportName=keyof typeof fullReportSchemas;
export async function readFullReport(db:Pool,name:FullReportName,raw:unknown) {
  const reader=reportSnapshotPool(db),environment=env.FAREJADOR_ENV;
  if(name==='vendas')return getSalesReport(salesReportQuery.parse(raw),true,environment,reader);
  if(name==='compras')return getPurchaseReport(purchaseReportQuery.parse(raw),true,environment,reader);
  if(name==='estoque')return getStockReport(stockReportQuery.parse(raw),environment,reader);
  if(name==='logistica')return getLogisticsReport(logisticsReportQuery.parse(raw),environment,reader);
  if(name==='financeiro') {
    const f=financialReportQuery.parse(raw);return buildFinancialReport(await readFinancialSnapshot(f,environment,reader),f);
  }
  if(name==='parceiros') {
    const f=partnerReportQuery.parse(raw);return buildPartnerReport(await readPartnerSnapshot(f,environment,reader),f);
  }
  const account=await dotChatwootAccount(db);if(!account)throw Error('chat_account_unavailable');
  if(name==='demanda') {
    const f=demandReportQuery.parse(raw);return buildDemandReport(await readDemandSnapshot(f,environment,reader,account),f);
  }
  const f=shortageReportQuery.parse(raw);return buildShortageReport(await readShortageSnapshot(f,environment,reader,account),f);
}
