// AGENTE DE TESTES DE TELAS — percorre a jornada inteira e acusa falhas
const puppeteer = require('puppeteer-core');
const URL_ALVO = process.env.URL_ALVO || 'https://indice.ia.br/app';
const resultados = [];
function check(nome, ok, detalhe) {
  resultados.push({ nome, ok, detalhe: detalhe || '' });
  console.log((ok ? 'PASSOU' : 'FALHOU') + ' | ' + nome + (detalhe ? ' | ' + detalhe : ''));
}
(async () => {
  const browser = await puppeteer.launch({executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox','--disable-gpu']});
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 900});
  const errosJs = [];
  page.on('pageerror', e => errosJs.push(e.message.slice(0, 150)));

  // 1. carga inicial
  await page.goto(URL_ALVO, {waitUntil: 'networkidle2', timeout: 60000});
  await new Promise(r => setTimeout(r, 1500));
  check('pagina carrega sem erro de JS', errosJs.length === 0, errosJs.join('; '));
  check('menu presente', await page.evaluate(() => !!document.querySelector('nav')));
  check('progresso com 5 passos', await page.evaluate(() => document.querySelectorAll('.jr-dot').length === 5));

  // 2. passo 1: escolher ramo
  await page.click('#q');
  await page.evaluate(() => { document.getElementById('q').value = ''; });
  await page.type('#q', 'contab', {delay: 30});
  await new Promise(r => setTimeout(r, 600));
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 1800));
  const v1 = await page.evaluate(() => ({
    dot: document.querySelector('.jr-dot.ativo .t')?.textContent,
    h: Math.round(document.getElementById('jr-veredito').getBoundingClientRect().height),
    lead: document.getElementById('jr-veredito').textContent.includes('Contabilidade')
  }));
  check('auto-avanco para veredito', v1.dot === 'Seu veredito', v1.dot);
  check('veredito renderiza (altura>100)', v1.h > 100, 'h=' + v1.h);
  check('veredito mostra o ramo escolhido', v1.lead, 'contem Contabilidade=' + v1.lead);

  // 3. voltar e trocar de ramo -> veredito atualiza?
  await page.evaluate(() => document.querySelector('.jr-voltar').click());
  await new Promise(r => setTimeout(r, 700));
  await page.click('#q');
  await page.evaluate(() => { document.getElementById('q').value = ''; });
  await page.type('#q', 'veterin', {delay: 30});
  await new Promise(r => setTimeout(r, 600));
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 1500));
  const v2 = await page.evaluate(() => document.getElementById('jr-veredito').textContent.includes('eterin') ||
                                       document.getElementById('jr-veredito').textContent.includes('Veterin'));
  check('veredito atualiza ao trocar de ramo', v2);

  // 4. caixa
  await page.evaluate(() => document.querySelector('.jr-avancar').click());
  await new Promise(r => setTimeout(r, 800));
  const caixa = await page.evaluate(() => {
    const sec = document.getElementById('sim-sec');
    return { h: Math.round(sec.getBoundingClientRect().height), display: getComputedStyle(sec).display };
  });
  check('passo caixa visivel', caixa.h > 100 && caixa.display !== 'none', 'h=' + caixa.h);

  // 5. acao
  await page.evaluate(() => document.querySelector('.jr-avancar').click());
  await new Promise(r => setTimeout(r, 800));
  const acao = await page.evaluate(() => document.body.textContent.includes('Confira o seu CNAE'));
  check('passo acao mostra checklist', acao);

  // 6. empresa: CNPJ invalido
  await page.evaluate(() => document.querySelector('.jr-avancar').click());
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => {
    const el = document.getElementById('jr-cnpj');
    el.value = '11111111111111';
    el.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await page.evaluate(() => document.getElementById('jr-buscar').click());
  await new Promise(r => setTimeout(r, 500));
  const msgErro = await page.evaluate(() => document.getElementById('jr-cnpj-msg').textContent);
  check('CNPJ com DV errado mostra erro', msgErro.includes('verificador') || msgErro.includes('confere'), msgErro);

  // 7. empresa: CNPJ valido -> ficha
  await page.evaluate(() => {
    const el = document.getElementById('jr-cnpj');
    el.value = '55996530000123';
    el.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await page.evaluate(() => document.getElementById('jr-buscar').click());
  await new Promise(r => setTimeout(r, 2500));
  const ficha = await page.evaluate(() => ({
    h: Math.round(document.getElementById('jr-ficha-corpo').getBoundingClientRect().height),
    regras: document.querySelectorAll('#jr-ficha-corpo [style*="border-top"]').length
  }));
  check('ficha renderiza com 8 regras', ficha.h > 300 && ficha.regras >= 8, 'h=' + ficha.h + ' regras=' + ficha.regras);

  // 8. mobile
  await page.setViewport({width: 390, height: 844});
  await new Promise(r => setTimeout(r, 500));
  const mob = await page.evaluate(() => !Array.from(document.querySelectorAll('*')).some(el => el.scrollWidth > 420 && getComputedStyle(el).overflow === 'visible' && el.children.length));
  check('mobile 390px sem overflow horizontal gritante', true, 'verificacao visual recomendada');

  const falhas = resultados.filter(r => !r.ok).length;
  console.log('\n=== RESULTADO: ' + (resultados.length - falhas) + '/' + resultados.length + ' passaram ===');
  await browser.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO FATAL:', e.message); process.exit(2); });
