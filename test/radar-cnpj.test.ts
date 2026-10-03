import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizarCnpj, dvValido, raizDe, formatarCnpj } from "../src/radar/cnpj.ts";
import { avaliar, type Estabelecimento } from "../src/radar/flags.ts";

test("aceita CNPJ numerico valido", () => {
  const c = normalizarCnpj("11.222.333/0001-81");
  assert.equal(c, "11222333000181");
  assert.ok(dvValido(c!));
});

test("aceita CNPJ alfanumerico no novo formato da Receita", () => {
  // exemplo do documento oficial da transicao: 12.ABC.345/01DE-35
  const c = normalizarCnpj("12.ABC.345/01DE-35");
  assert.equal(c, "12ABC34501DE35");
  assert.ok(dvValido(c!));
});

test("rejeita DV invalido (exemplo de mascara do README)", () => {
  const c = normalizarCnpj("53.486.573/0001-43");
  assert.equal(c, "53486573000143");
  assert.equal(dvValido(c!), false);
});

test("rejeita tamanho e caracteres errados", () => {
  assert.equal(normalizarCnpj("11.222.333/0001"), null);
  assert.equal(normalizarCnpj("11.222.333/0001-8!"), null);
});

test("raiz e formatacao", () => {
  assert.equal(raizDe("11222333000181"), "11222333");
  assert.equal(formatarCnpj("11222333000181"), "11.222.333/0001-81");
});

const base: Estabelecimento = {
  cnpj: "11222333000181",
  cnpj_raiz: "11222333",
  razao_social: "Exemplo LTDA",
  nome_fantasia: null,
  matriz_filial: "1",
  cnae_principal: "6911701",
  cnaes_secundarios: null,
  uf: "SP",
  municipio_codigo: "7107",
  porte: "03",
  simples: "S",
  mei: "N",
  data_inicio: "20200115",
};

test("flags: advocacia no Simples acende 127 + decisao_simples", () => {
  const a = avaliar(base, [], "2026-09");
  assert.deepEqual(a.flags, ["elegivel_127", "decisao_simples"]);
  assert.equal(a.score, 70);
  assert.match(a.detalhes.frase_trabalho, /art\. 127/);
});

test("flags: CNAE principal fora do 127 com secundario dentro marca suspeito", () => {
  const a = avaliar({ ...base, cnae_principal: "4711302", cnaes_secundarios: "6911701" }, [], "2026-09");
  assert.ok(a.flags.includes("cnae_suspeito"));
});

test("flags: CNPJ nao encontrado retorna score zero e orientacao", () => {
  const a = avaliar(null, [], "2026-09");
  assert.equal(a.score, 0);
  assert.equal(a.flags.length, 0);
  assert.match(a.detalhes.frase_trabalho, /nao encontrado/);
});

test("score nunca passa de 100", () => {
  const a = avaliar(base, ["cnae_changed"], "2026-09");
  assert.ok(a.score <= 100);
});
