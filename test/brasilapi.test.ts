import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBrasilApi } from "../src/index.ts";

test("normaliza resposta da BrasilAPI para o formato da interface", () => {
  const row = normalizeBrasilApi({
    cnpj: "53.486.573/0001-43",
    razao_social: "EMPRESA TESTE LTDA",
    cnae_fiscal: 6201501,
    descricao_situacao_cadastral: "ATIVA",
    opcao_pelo_simples: true,
  });
  assert.equal(row.cnpj, "53486573000143");
  assert.equal(row.cnae, "6201501");
  assert.equal(row.situacao, "ATIVA");
  assert.equal(row.simples, true);
});
