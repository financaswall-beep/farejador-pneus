import { env } from '../../shared/config/env.js';
import { getMatrizCollaboratorManagement } from '../painel/queries-colaboradores-gestao.js';
import { project, pageRows, rejectFilters, type DotReadContext } from './read-model.js';

export async function readDotTeam(ctx:DotReadContext) {
  rejectFilters(ctx,'medida');
  const data=await getMatrizCollaboratorManagement(ctx.period.month+'-01',env.FAREJADOR_ENV,ctx.db);
  const eligible=data.collaborators.filter(row=>row.eligible_in_competence);
  const configured=eligible.filter(row=>row.employment_type||row.commission_active);
  const frozen=eligible.filter(row=>row.payroll_item_id);
  const population=frozen.length?frozen:configured;
  const guarded=(field:keyof typeof data.summary,rows:typeof eligible)=>rows.length>=3?data.summary[field]:null;
  const financial=population.length>=3?{
    base_salary_total:guarded('base_salary_total',eligible.filter(row=>row.base_salary>0)),
    commission_total:guarded('commission_total',eligible.filter(row=>row.commission_amount>0)),
    payroll_total:guarded('payroll_total',population.filter(row=>row.total_due>0)),
    payroll_payable:guarded('payroll_payable',eligible.filter(row=>row.payroll_status==='pending'&&row.total_due>0)),
    payroll_paid:guarded('payroll_paid',eligible.filter(row=>row.payroll_status==='paid'&&row.total_due>0)),
    payroll_count:population.length,payroll_period_status:data.summary.payroll_period_status,
  }:null;
  const rows=data.collaborators.filter(row=>!ctx.input.referencia||row.id===ctx.input.referencia)
    .map(row=>project(row,['id','job','work_area','active','sales_count','revenue','margin','items_without_cost',
      'deliveries_count','trips_count','distance_km','on_time_pct']));
  return {month:ctx.period.month,monetary_unit:'BRL',...pageRows(rows,ctx.input.pagina),
    summary:project(data.summary,['active_count','revoked_count','configured_count','unconfigured_count','sales_eligible',
      'deliveries_eligible','payroll_review_count','payroll_review_reasons']),financial,
    financial_available:financial!==null,
    warning:'Folha por competência mensal. Valores individuais, nomes, usuários e dados de pagamento omitidos. Totais da equipe exigem ao menos três colaboradores elegíveis; prévia não é pagamento.'};
}
