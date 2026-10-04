#!/usr/bin/env bash
# Radar v0 — execucao local da base da Receita (requer IP brasileiro).
# Uso:
#   export R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
#   export RADAR_INTERNAL_KEY RADAR_WORKER_URL   # para a etapa de carga
#   bash pipeline/radar/rodar_local.sh ensaio     # mede 1 fragmento
#   bash pipeline/radar/rodar_local.sh completo   # extrai o recorte todo
#   bash pipeline/radar/rodar_local.sh carga      # carrega o D1 via Worker
set -euo pipefail
ETAPA="${1:?uso: rodar_local.sh ensaio|completo|carga}"
UF="${UF:-SP}"
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

if [ ! -f .venv-radar/.ok ]; then
  rm -rf .venv-radar
  python3 -m venv .venv-radar
  # o radar so precisa de boto3+requests; pyiceberg/pyarrow sao do pipeline antigo
  ./.venv-radar/bin/pip install --quiet boto3 requests
  touch .venv-radar/.ok
fi
PYBIN=./.venv-radar/bin/python
PY=./.venv-radar/bin/python
# prioridade baixa para nao disputar com outros apps do servidor
if command -v ionice >/dev/null 2>&1; then NICER="ionice -c3 nice -n 19"; else NICER="nice -n 19"; fi

if [ ! -f plan.json ]; then
  echo ">> descobrindo competencia mais recente..."
  $NICER $PY pipeline/discover_rfb.py > plan.json
fi
echo ">> plano: $($PY -c "import json;p=json.load(open('plan.json'));print(p['snapshot'], len(p['include']), 'ZIPs')")"

case "$ETAPA" in
  ensaio)
    $NICER $PY pipeline/radar/extrair_recorte.py --plan plan.json --uf "$UF" --ensaio | tee resultado-ensaio.json
    echo ">> ensaio concluido; veja a projecao acima e o quality-ensaio.json no R2"
    ;;
  completo)
    $NICER $PY pipeline/radar/extrair_recorte.py --plan plan.json --uf "$UF" | tee resultado.json
    echo ">> recorte no R2; rode: bash pipeline/radar/rodar_local.sh carga"
    ;;
  carga)
    BUILD_ID="${BUILD_ID:-$($PY -c "import json;print(json.load(open('resultado.json'))['build_id'])")}"
    echo ">> carregando build $BUILD_ID no D1..."
    OFFSET=0
    for i in $(seq 1 500); do
      RESP=$(curl -sf -X POST "$RADAR_WORKER_URL/internal/radar/load"         -H "x-internal-key: $RADAR_INTERNAL_KEY"         -H "content-type: application/json"         -d "{"build_id":"$BUILD_ID","offset":$OFFSET,"limit":5}")
      echo "$RESP"
      DONE=$(echo "$RESP" | $PY -c "import json,sys;print(json.load(sys.stdin)['done'])")
      [ "$DONE" = "True" ] && echo ">> CARGA CONCLUIDA" && exit 0
      OFFSET=$(echo "$RESP" | $PY -c "import json,sys;print(json.load(sys.stdin)['proximo_offset'])")
      sleep 2
    done
    echo ">> limite de iteracoes; rode de novo que retoma"; exit 1
    ;;
  *) echo "etapa desconhecida: $ETAPA"; exit 1 ;;
esac
