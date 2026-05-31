# Seção: <NOME>

- **Status:** ✅ estável · 🚧 em obra · ⚠️ funcional com ressalvas
- **Última auditoria:** AAAA-MM-DD
- **Responsável pela auditoria:** <quem>

## O que é / responsabilidade
<O que essa seção faz. O que NÃO é responsabilidade dela.>

## Tabelas que possui (owner)
| Tabela | Colunas-chave | Observação |
|---|---|---|
| `schema.tabela` | ... | ... |

## Endpoints
| Método | Rota | Auth | Body | Retorno |
|---|---|---|---|---|
| GET | `/parceiro/:slug/api/...` | Bearer token | — | `{ rows: [...] }` |

## Como LER (outra seção consultando esta)
<Qual endpoint/função chamar e o que esperar de volta.>

## Como GRAVAR
<Qual endpoint, validações obrigatórias, invariantes.>

## Invariantes (sempre valem)
- ...

## ⛔ NÃO faça
- ...

## Arquivos-fonte
- Front: `parceiro/public/...`
- Rotas: `src/parceiro/route.ts`
- Queries: `src/parceiro/queries.ts`

## Ressalvas conhecidas / dívidas
- ...
