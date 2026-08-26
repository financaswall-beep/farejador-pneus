export const MATRIX_PANEL_MODULES = [
  'resumo', 'bot', 'vendas', 'retiradas', 'clientes', 'compras', 'estoque',
  'logistica', 'financeiro', 'rede', 'marketing', 'colaboradores', 'catalogo',
] as const;

export type MatrixPanelModule = (typeof MATRIX_PANEL_MODULES)[number];

export type MatrixPanelPermissionRow = {
  [K in `allow_${MatrixPanelModule}`]: boolean | null;
};

const ADMIN_LEGACY_DEFAULTS: Readonly<Record<MatrixPanelModule, boolean>> = {
  resumo: true,
  bot: true,
  vendas: true,
  retiradas: false,
  clientes: true,
  compras: true,
  estoque: true,
  logistica: true,
  financeiro: true,
  rede: true,
  marketing: false,
  colaboradores: false,
  catalogo: true,
};

export const MATRIX_PANEL_PERMISSION_COLUMNS = MATRIX_PANEL_MODULES
  .map((module) => `op.allow_${module}`).join(',');

export function matrixPanelModules(
  role: 'owner' | 'admin',
  row?: Partial<MatrixPanelPermissionRow> | null,
): MatrixPanelModule[] {
  if (role === 'owner') return [...MATRIX_PANEL_MODULES];
  return MATRIX_PANEL_MODULES.filter((module) => {
    const value = row?.[`allow_${module}`];
    return typeof value === 'boolean' ? value : ADMIN_LEGACY_DEFAULTS[module];
  });
}

/**
 * Contrato central do painel administrativo. A UI usa os mesmos nomes, e esta
 * tabela impede que esconder um item do menu seja confundido com autorização.
 * Mais de um módulo significa "qualquer um deles" (uma consulta compartilhada).
 */
export function requiredMatrixModules(pathname?: string): MatrixPanelModule[] | null {
  const value = String(pathname || '');
  const path = value.split('?')[0] || value;
  if (/^\/admin\/api\/(auth|integrity)(\/|$)/.test(path)) return null;
  if (/^\/admin\/api\/dashboard\/matriz-resumo/.test(path)) return ['resumo'];
  if (/^\/admin\/api\/dashboard\/(pedidos|produtos)/.test(path)) return ['resumo'];
  if (/^\/admin\/api\/dashboard\/rede/.test(path)) return ['rede'];
  if (/^\/admin\/api\/(bot|demanda)(\/|$)/.test(path)) return ['bot'];
  if (/^\/admin\/api\/(clientes|clientes-v2|privacy)(\/|$)/.test(path)) return ['clientes'];
  if (/^\/admin\/api\/wholesale\/(purchase|purchases|purchase-orders|supplier|suppliers|replenishment)/.test(path)) return ['compras'];
  if (/^\/admin\/api\/wholesale\/stock/.test(path)) return ['estoque'];
  if (/^\/admin\/api\/logistica(\/|$)/.test(path)) return ['logistica'];
  if (/^\/admin\/api\/(matriz\/(financeiro|despesas)|financeiro)(\/|$)/.test(path)) return ['financeiro'];
  if (/^\/admin\/api\/wholesale\/finance/.test(path)) return ['financeiro'];
  if (/^\/admin\/api\/(partners|candidaturas|applications|rede)(\/|$)/.test(path)) return ['rede'];
  if (/^\/admin\/api\/marketing(\/|$)/.test(path)) return ['marketing'];
  if (/^\/admin\/api\/colaboradores(\/|$)/.test(path)) return ['colaboradores'];
  if (/^\/admin\/api\/(catalogo|catalog)(\/|$)/.test(path)) return ['catalogo'];
  if (/^\/admin\/api\/retiradas(\/|$)/.test(path)) return ['retiradas'];
  if (/^\/admin\/api\/(orders|vendas)(\/|$)/.test(path)) return ['vendas'];
  if (/^\/admin\/api\/wholesale\/(sales|sale|commission|comissoes)/.test(path)) {
    return ['vendas', 'financeiro'];
  }
  if (/^\/admin\/api\/matriz\/notificacoes/.test(path)) return ['resumo'];
  return null;
}
