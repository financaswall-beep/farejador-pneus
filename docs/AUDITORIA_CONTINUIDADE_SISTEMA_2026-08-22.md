# Auditoria de continuidade do sistema — 22/08/2026

## Objetivo

Esta auditoria não revisou uma aba isolada. Ela verificou a continuidade do Farejador como
um todo: passagem dos dias, semanas, meses e anos; calendário da Matriz e dos parceiros;
migrations; partições; retenção operacional; filas; integrações; saúde do banco e recuperação
de lacunas do Marketing.

Os registros atuais foram tratados como dados de teste. Não foi feita conciliação comercial
nem limpeza destrutiva nesta etapa. A eliminação da massa de teste deve ser uma operação
controlada e separada, imediatamente antes do início real, com backup e lista explícita das
tabelas que podem ser limpas. Eventos brutos e trilhas que precisem ser preservados não devem
ser apagados por uma limpeza genérica.

## Correções aplicadas

### 1. Um calendário para todo o sistema

Foi criado um contrato único de tempo para navegador, servidor e banco, sempre baseado em
`America/Sao_Paulo`.

- Datas puras, como `2026-08-22`, não mudam de dia por causa do país do Supabase, do
  Coolify ou do computador do usuário.
- Instantes completos são apresentados no horário de São Paulo.
- Matriz, parceiro e Caixa usam o mesmo cálculo de hoje, semanas, meses e nomes de arquivos.
- Comissões do parceiro fecham as faixas pelo dia comercial brasileiro, inclusive entre
  21h e 23h59, quando o UTC já está no dia seguinte.
- Defaults de vigência de remuneração e comissão no banco usam o dia de São Paulo.

### 2. Continuidade das migrations

A migration aditiva `0199_system_continuity.sql` cria um marcador canônico pertencente ao
Farejador: `ops.application_schema_state`. O runtime passa a recusar prontidão quando o banco
não comprovar pelo menos a versão 199.

Isso evita depender exclusivamente do histórico interno do Supabase, que neste projeto foi
preenchido por executores diferentes ao longo do tempo. A migration também valida três
constraints históricas que ainda estavam em modo `NOT VALID`.

### 3. Meses futuros preparados automaticamente

A migration prepara o mês corrente e mais seis meses de partições. No dia 20 de cada mês, o
PostgreSQL renova automaticamente três meses à frente. A prontidão reprova se faltarem
partições do mês corrente ou dos dois meses seguintes, ou se o agendamento estiver inativo.

### 4. Limpeza apenas do lixo operacional

Uma rotina diária remove apenas resíduos cujo ciclo terminou:

| Dado operacional | Retenção |
|---|---:|
| sessões vencidas/revogadas da Matriz e parceiro | 30 dias |
| histórico de execução do `pg_cron` | 30 dias |
| sincronizações Meta concluídas | 365 dias |
| dead letters já resolvidas | 180 dias |

A rotina não apaga `raw_events`, vendas, compras, estoque, financeiro, comprovantes ou
histórico comercial. A imutabilidade da camada bruta foi preservada.

### 5. Marketing recupera períodos sem execução

Ao iniciar, o sincronizador Meta mede o último período concluído e recupera automaticamente
a lacuna. A janela normal mínima é de 60 dias e o limite seguro é de 365 dias. Depois disso,
o ciclo programado volta à janela normal de sete dias.

### 6. Saúde operacional verificável

`/readyz`, `/healthz` e o novo `/operational-healthz` agora verificam e informam:

- versão canônica do schema;
- partições atuais e futuras;
- agendamentos de partição e retenção;
- webhook Chatwoot parado, pendente ou com falhas;
- dead letters abertas;
- jobs e mensagens de saída presos;
- sincronização Meta presa;
- crescimento excessivo do histórico do cron.

Ausência de migration, partição ou renovação automática bloqueia a prontidão. Situações que
pedem intervenção, mas não justificam retirar imediatamente o sistema do ar, aparecem como
avisos de degradação.

## Baterias executadas após as correções

| Prova | Resultado |
|---|---|
| Unitários completos no fuso UTC | **1.289/1.289**, 260 arquivos |
| Unitários completos simulando Los Angeles | **1.289/1.289**, 260 arquivos |
| Integração completa com PostgreSQL | **272/272**, 53 arquivos |
| Migration `0199` específica em PostgreSQL 17 | **3/3** |
| Replay/manifesto de migrations | **200 migrations**, última `0199` |
| TypeScript e build | aprovados |
| Painel parceiro | 597 propriedades preservadas |
| Painel Matriz | 1.103 propriedades preservadas |
| Contratos de API | 93 preservados |
| Rotas do painel Matriz | 242 preservadas; nova rota de horário catalogada |
| Fiscal de tamanho | 524 arquivos aprovados |
| Dependências npm | zero vulnerabilidades conhecidas |

As mensagens de encerramento de conexão vistas durante a integração fazem parte das provas
de queda e recuperação do PostgreSQL; os lotes só foram aprovados depois da recuperação.

## Por quanto tempo o sistema roda sozinho?

Não existe uma data de expiração no código. Com a `0199` aplicada, o sistema renova partições
mensalmente, limpa resíduos diariamente e recupera lacunas do Marketing na inicialização.
Portanto, pode continuar operando por tempo indeterminado enquanto estas dependências
externas continuarem saudáveis:

- servidor/Coolify e PostgreSQL disponíveis e com espaço;
- `pg_cron` ativo;
- domínio e certificado renovados;
- credenciais Chatwoot, Meta, Supabase e demais provedores válidas;
- planos, cobrança e limites dos provedores ativos;
- backups executados e restauração testada;
- alertas operacionais observados por uma pessoa.

Nenhum sistema de produção deve ser declarado capaz de operar para sempre sem manutenção.
O objetivo destas correções é transformar passagem do tempo e pequenas interrupções em
rotinas automáticas, deixando para a operação humana apenas falhas externas, alertas e
decisões comerciais.

## Estado para publicação

A migration `0199` foi aplicada no banco-alvo em 22/08/2026, antes do deploy do aplicativo.
O backup lógico pré-migration foi validado com 5.037.565 bytes, 2.667 entradas restauráveis
e SHA-256 `42154DCC1EA0B17DFCDD8DF8F8759DF40B54BD83E8326DDD9DEED23F27AFD3FC`.
O dry-run integral foi revertido sem deixar objetos e a aplicação posterior terminou com
`COMMIT`.

A reconciliação pós-commit confirmou schema canônico 199, três constraints validadas,
quatro índices de retenção, dois defaults de São Paulo, zero partições ausentes e os jobs de
partição e retenção ativos. Não há bloqueador crítico. A primeira execução da retenção ainda
não foi observada, o último webhook Chatwoot é de 20/08/2026 e existem 11 dead letters antigas;
esses três avisos não impedem o deploy e devem ser reavaliados depois da limpeza da massa de
teste e da primeira execução programada.

Ordem obrigatória para concluir:

1. ~~criar e validar backup restaurável do banco-alvo~~ — concluído;
2. definir e executar a limpeza controlada dos dados de teste;
3. ~~aplicar a migration `0199` e conferir o marcador canônico~~ — concluído;
4. publicar o código pelo Coolify;
5. executar smoke autenticado de Matriz, parceiro, Caixa e fluxos críticos;
6. conferir `/readyz` e `/operational-healthz` sem bloqueadores;
7. rotacionar os segredos Chatwoot expostos e reautorizar a Meta;
8. fazer um teste real canário e reconciliar estoque, financeiro e pedido.

## Veredito

**Aprovado tecnicamente, inclusive no banco, para deploy controlado.** Não é ainda uma
autorização final de produção: faltam limpeza da massa de teste, deploy, smoke autenticado,
rotação de segredos e teste canário. Depois desses gates, o veredito pode ser convertido em
autorização formal de go-live.
