#!/usr/bin/env bash
# Primer push de la Fase 0. Se corre una sola vez, desde tu computadora.
set -euo pipefail

REPO="https://github.com/recargayapy/recargaya-platform.git"
RAMA="fase-0-fundaciones-y-spike-financiero"

echo
echo "  Fase 0 — Fundaciones y el spike financiero"
echo "  ==========================================="
echo

# No pisar nada por accidente: si ya hay un .git acá, es otro repositorio.
if [ -d .git ]; then
  echo "  Ya hay un repositorio git en esta carpeta."
  echo "  Corré este script en la carpeta recién descomprimida, no adentro de otro repo."
  exit 1
fi

echo "  1/5  Verificando antes de subir nada..."
if command -v npm >/dev/null 2>&1; then
  npm install --silent --no-fund --no-audit
  npm run tipos
  npm run probar
  npm run mutar
  echo "       tipos, pruebas y mutación: los tres pasaron."
else
  echo "       npm no está instalado — se sube sin verificar localmente."
  echo "       El CI de GitHub va a correr los tres oráculos igual."
fi

echo "  2/5  Iniciando el repositorio..."
git init -q
git branch -M main

echo "  3/5  Trayendo lo que ya hay en GitHub..."
git remote add origin "$REPO"
git fetch origin main -q
git reset --soft origin/main   # conserva los archivos, adopta la historia

echo "  4/5  Creando la rama y el commit..."
git checkout -q -b "$RAMA"
git add -A

# Verificación final: que no se cuele un secreto. Esto no falla ruidosamente
# solo, así que se busca a propósito.
if git diff --cached --name-only | grep -Eq '(^|/)\.dev\.vars$|\.env$'; then
  echo
  echo "  FRENÁ: hay un archivo de secretos en el commit."
  echo "  Un secreto subido queda en la historia para siempre."
  exit 1
fi

git commit -q -m "Fase 0: fundaciones y el spike financiero

Qué trae
--------
- Proyecto de Wrangler con staging y producción SEPARADOS. Recursos distintos:
  si compartieran base, una prueba en staging movería plata de verdad.
- TypeScript estricto, Vitest, y .dev.vars en .gitignore desde este commit.
- Primera migración de D1 versionada, con el ledger append-only protegido por
  trigger: un asiento no se edita ni se borra, se compensa (ley 2).
- El núcleo del dinero: guaraníes enteros, bolsas con origen y vencimiento,
  precedencia de consumo como función pura (ley 4) y la regla anticajero
  (ley 11).
- EL SPIKE: el reparto de una venta entre cuatro billeteras como pasos
  idempotentes, con caída inyectada en cada paso.
- CI con los tres oráculos, y el despliegue automático a staging.

Por qué así
-----------
En Cloudflare no hay transacción distribuida. Una venta toca cuatro Durable
Objects y nada los abarca: si el Worker muere entre el paso dos y el tres, el
cliente pagó y el creador no cobró. La respuesta es un Workflow con pasos
idempotentes cuya clave identifica la INTENCIÓN, no el momento — reintentar el
paso que falló no vuelve a pagar.

Las pruebas inyectan la caída de dos formas por cada paso: antes de aplicar, y
después de aplicar pero antes de registrarlo. La segunda es la que rompe los
sistemas mal diseñados, porque el llamador cree que falló y en realidad se hizo.

Verificación
------------
36 pruebas · 18 mutaciones, todas muertas · tipos limpios.

La mutación encontró cuatro agujeros en la primera pasada y los cuatro están
cerrados: el oráculo de invariantes no tenía pruebas propias, y el arnés no
comprobaba que el Workflow reanudara desde el paso que falló.

Falta: la segunda vuelta de auditoría adversarial. Se avisa antes de entregar,
no después."

echo "  5/5  Subiendo..."
git push -u origin "$RAMA"

echo
echo "  Listo. Abrí el pull request acá:"
echo
echo "  https://github.com/recargayapy/recargaya-platform/compare/$RAMA?expand=1"
echo
echo "  El CI va a correr solo: tipos, pruebas y mutación."
echo "  Para el despliegue, seguí docs/PRIMER-DESPLIEGUE.md"
echo
