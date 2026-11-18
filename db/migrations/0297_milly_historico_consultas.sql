BEGIN;

ALTER TABLE ops.milly_consultas
  ADD COLUMN context_read_at timestamptz,
  ADD COLUMN context_snapshot jsonb,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_rationale text,
  ADD CONSTRAINT milly_justificativa_privada CHECK (
    decision_rationale IS NULL OR (
      decision IS NOT NULL AND char_length(btrim(decision_rationale)) BETWEEN 1 AND 300
      AND decision_rationale !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT milly_contexto_com_data CHECK (
    (context_read_at IS NULL) = (context_snapshot IS NULL)
    AND (context_snapshot IS NULL OR jsonb_typeof(context_snapshot) = 'object')
  );

COMMENT ON COLUMN ops.milly_consultas.context_snapshot IS
  'Dados comerciais selecionados da última ficha devolvida pelo MCP antes da decisão.';
COMMENT ON COLUMN ops.milly_consultas.decided_at IS
  'Instante de registro do parecer. Pareceres anteriores à instrumentação mantêm NULL.';
COMMENT ON COLUMN ops.milly_consultas.decision_rationale IS
  'Justificativa comercial opcional do aval, privada para o proprietário.';

-- Também carimba decisões de uma instância anterior da aplicação durante o deploy.
CREATE FUNCTION ops.milly_carimbar_decisao() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER milly_carimbar_decisao
  BEFORE UPDATE OF decision ON ops.milly_consultas FOR EACH ROW
  WHEN (OLD.decision IS NULL AND NEW.decision IS NOT NULL)
  EXECUTE FUNCTION ops.milly_carimbar_decisao();
REVOKE ALL ON FUNCTION ops.milly_carimbar_decisao() FROM PUBLIC;

COMMIT;
