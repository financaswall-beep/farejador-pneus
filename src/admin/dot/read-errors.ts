const messages:Record<string,string>={
  unknown_source:'Fonte não disponível. Consulte listar_fontes_matriz.',
  field_not_available:'Campo não disponível. Consulte os campos da fonte em listar_fontes_matriz.',
  filter_not_available:'Filtro não disponível para esta fonte. Consulte listar_fontes_matriz.',
  response_too_large_reduce_limit_or_fields:'Resposta grande demais. Reduza limite ou selecione menos campos; continue pelas páginas.',
  report_too_large_select_section:'Relatório grande demais. Selecione uma seção e percorra suas páginas.',
  csv_requires_list_section:'Para exportar CSV, escolha em secao uma lista do relatório.',
  unknown_report_section:'Seção não disponível. Consulte primeiro o relatório em JSON.',
  attachment_not_found:'Anexo não encontrado, apagado ou fora do acesso autorizado.',
  attachment_too_large:'Arquivo acima do limite de leitura de 16 MiB.',
  chat_account_unavailable:'Conta de atendimento indisponível ou ambígua; não é possível consultar suas conversas.',
  creative_not_owned_or_not_found:'Anúncio não encontrado entre os anúncios próprios verificados da Matriz.',
};
export function dotReadError(error:unknown):string {
  return (error instanceof Error?messages[error.message]:undefined)
    ??'Consulta indisponível ou filtros/período inválidos para esta visão. Não interprete como resultado zero.';
}
