import test from "node:test";
import assert from "node:assert/strict";
import { renderApp } from "../src/ui.ts";

test("formulário usa a rota própria e exibe CNPJ formatado", () => {
  const html = renderApp("GPTchat CNPJ");
  assert.match(html, /00\.000\.000\/0000-00/);
  assert.match(html, /fetch\('\/api\/cnpj\/'/);
  assert.match(html, /BrasilAPI \+ base própria/);
});
