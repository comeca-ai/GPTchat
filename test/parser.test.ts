import test from "node:test";
import assert from "node:assert/strict";
import { heuristicPlan, normalize } from "../src/parser.ts";

test("normaliza português", () => assert.equal(normalize("São José & Cia."), "sao jose cia"));
test("extrai CNPJ e intenção de sócios", () => {
  const p = heuristicPlan("Quem são os sócios do CNPJ 12.345.678/0001-99?");
  assert.equal(p.intent, "partners"); assert.equal(p.cnpj, "12345678000199");
});
test("mantém os 14 dígitos do CNPJ informado pelo usuário", () => {
  const p = heuristicPlan("53.486.573/0001-43");
  assert.equal(p.intent, "company");
  assert.equal(p.cnpj, "53486573000143");
});
test("extrai UF e MEI", () => {
  const p = heuristicPlan("MEIs ativos em GO");
  assert.equal(p.state, "GO"); assert.equal(p.mei, true); assert.equal(p.activeOnly, true);
});
test("aceita CNPJ alfanumérico de 2026", () => {
  const p = heuristicPlan("consulte 12.ABC.678/0001-90");
  assert.equal(p.cnpj, "12ABC678000190");
});
