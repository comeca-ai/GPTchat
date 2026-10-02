const API = "https://publica.cnpj.ws/cnpj/";

const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPTchat CNPJ</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5ef;color:#142319;font:16px/1.5 Inter,system-ui,sans-serif}main{max-width:860px;margin:auto;padding:36px 20px}nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:12vh}.logo{font-weight:900;font-size:21px}.tag{font-size:12px;background:#dcf6c3;padding:7px 11px;border-radius:999px}.hero{text-align:center}h1{font-size:clamp(42px,8vw,74px);line-height:1;letter-spacing:-.055em;margin:0 0 22px}p{color:#69756c}.search{margin:36px auto 0;max-width:650px;background:white;border:1px solid #dae2d7;border-radius:20px;padding:10px;box-shadow:0 22px 70px #1a3b2114;display:flex;gap:8px}input{flex:1;border:0;outline:0;font-size:17px;padding:15px;background:transparent;min-width:0}button{border:0;border-radius:12px;background:#153b24;color:white;font-weight:800;padding:0 20px;cursor:pointer}.status{min-height:28px;margin-top:20px}.card{text-align:left;margin:12px auto;padding:20px;max-width:650px;background:white;border:1px solid #dee5dc;border-radius:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.label{font-size:12px;color:#7a857d;text-transform:uppercase;letter-spacing:.06em}.value{font-weight:650}.error{color:#a72b2b}@media(max-width:600px){nav{margin-bottom:70px}.search{display:block}.search button{width:100%;height:46px}.grid{grid-template-columns:1fr}}</style></head>
<body><main><nav><div class="logo">GPTchat</div><div class="tag">CNPJ público</div></nav><section class="hero"><h1>Consulte uma empresa brasileira.</h1><p>Digite um CNPJ para ver os dados cadastrais públicos em segundos.</p><form class="search" id="f"><input id="q" inputmode="numeric" autocomplete="off" placeholder="00.000.000/0001-00" aria-label="CNPJ" required><button>Consultar →</button></form><div class="status" id="s"></div><div id="r"></div></section></main><script>
const f=document.querySelector('#f'),q=document.querySelector('#q'),s=document.querySelector('#s'),r=document.querySelector('#r');q.oninput=()=>{let v=q.value.replace(/\D/g,'').slice(0,14);q.value=v.replace(/^(\d{2})(\d)/,'$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/,'$1.$2.$3').replace(/\.(\d{3})(\d)/,'.$1/$2').replace(/(\d{4})(\d)/,'$1-$2')};f.onsubmit=async e=>{e.preventDefault();const n=q.value.replace(/\D/g,'');if(n.length!==14){s.innerHTML='<span class="error">Digite os 14 números do CNPJ.</span>';return}s.textContent='Consultando…';r.innerHTML='';try{const x=await fetch('/api/cnpj/'+n),d=await x.json();if(!x.ok)throw Error(d.error||'Consulta indisponível');s.textContent='';const est=d.estabelecimento||{},cid=est.cidade||{};r.innerHTML='<div class="card"><div class="label">Razão social</div><h2>'+esc(d.razao_social||'—')+'</h2><div class="grid">'+field('Nome fantasia',est.nome_fantasia)+field('Situação',est.situacao_cadastral)+field('CNPJ',est.cnpj)+field('Localidade',[cid.nome,cid.uf?.sigla].filter(Boolean).join(' / '))+field('Natureza jurídica',d.natureza_juridica?.descricao)+field('Porte',d.porte?.descricao)+'</div></div>'}catch(err){s.innerHTML='<span class="error">'+esc(err.message)+'</span>'}};function field(a,b){return '<div><div class="label">'+esc(a)+'</div><div class="value">'+esc(b||'—')+'</div></div>'}function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
</script></body></html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(page, {headers:{"content-type":"text/html;charset=UTF-8","cache-control":"public,max-age=300"}});
    const match = url.pathname.match(/^\/api\/cnpj\/(\d{14})$/);
    if (request.method === "GET" && match) {
      const cache = caches.default;
      const key = new Request(url.toString(), request);
      const saved = await cache.match(key);
      if (saved) return saved;
      const upstream = await fetch(API + match[1], {headers:{accept:"application/json"}});
      if (!upstream.ok) return Response.json({error:upstream.status===404?"CNPJ não encontrado.":"Fonte temporária indisponível. Tente novamente em instantes."},{status:upstream.status});
      const response = new Response(upstream.body,{headers:{"content-type":"application/json;charset=UTF-8","cache-control":"public,max-age=86400","x-data-source":"cnpj.ws-temporary"}});
      await cache.put(key,response.clone());
      return response;
    }
    return Response.json({error:"Rota não encontrada"},{status:404});
  }
};
