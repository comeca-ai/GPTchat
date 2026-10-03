/** Validacao de CNPJ com suporte ao formato alfanumerico da Receita.
 * Regra do DV: cada caractere vale charCode - 48 (digitos 0-9 -> 0-9,
 * letras A-Z -> 17-42); pesos ciclam 2..9 da direita para a esquerda;
 * digito = 11 - (soma % 11), com resultado < 2 virando 0.
 */

export function normalizarCnpj(entrada: string): string | null {
  const limpo = entrada.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (limpo.length !== 14) return null;
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(limpo)) return null;
  return limpo;
}

function valor(c: string): number {
  return c.charCodeAt(0) - 48;
}

function digito(base: string): string {
  const n = base.length;
  let soma = 0;
  for (let j = 0; j < n; j++) {
    soma += valor(base[j]) * (((n - 1 - j) % 8) + 2);
  }
  const resto = soma % 11;
  return resto < 2 ? "0" : String(11 - resto);
}

export function dvValido(cnpj: string): boolean {
  const base = cnpj.slice(0, 12);
  return digito(base) === cnpj[12] && digito(base + cnpj[12]) === cnpj[13];
}

export function raizDe(cnpj: string): string {
  return cnpj.slice(0, 8);
}

export function formatarCnpj(cnpj: string): string {
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}
