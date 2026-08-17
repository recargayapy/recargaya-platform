#!/usr/bin/env node
/**
 * Pruebas propias de check-esquema.mjs.
 *
 * Node plano, no vitest, a proposito: es la herramienta que prueba a la
 * herramienta que existe justamente porque `npm run probar` (vitest) no
 * alcanza a este archivo — no tiene sentido atar su propia verificacion a lo
 * mismo que no la cubria.
 *
 * Uso: node herramientas/check-esquema.pruebas.mjs
 */

import assert from 'node:assert/strict'
import { compararEsquemas, extraerTipoBolsa, extraerCheckBolsa } from './check-esquema.mjs'

assert.deepEqual(
  compararEsquemas(['disponible', 'retenido'], ['disponible', 'retenido']),
  { ok: true, faltantes: [], sobrantes: [] },
)

assert.deepEqual(
  compararEsquemas(['disponible', 'retenido'], ['disponible']),
  { ok: false, faltantes: ['retenido'], sobrantes: [] },
)

assert.deepEqual(
  compararEsquemas(['disponible'], ['disponible', 'fantasma']),
  { ok: false, faltantes: [], sobrantes: ['fantasma'] },
)

assert.deepEqual(extraerTipoBolsa(`export type TipoBolsa = 'disponible' | 'retenido'\n`), [
  'disponible',
  'retenido',
])

assert.deepEqual(
  extraerCheckBolsa(`  bolsa TEXT NOT NULL CHECK (bolsa IN ('disponible', 'retenido')),\n`),
  ['disponible', 'retenido'],
)

assert.throws(() => extraerTipoBolsa('nada por aca'), /no se encontro/)
assert.throws(() => extraerCheckBolsa('nada por aca'), /no se encontro/)



// --- de punta a punta ------------------------------------------------------
// Las de arriba prueban las funciones puras. Sin esto, `main()` no lo ejercita
// nadie: la mutacion del guard del CLI —invocarlo y que no verifique nada—
// sobrevivia, porque estas pruebas nunca corrian el proceso.
//
// Para ser exacto con el credito: que `check-esquema.mjs` tuviera el guard viejo
// lo encontro una auditoria adversarial. Lo que encontro el arnes de mutacion fue
// que la mutacion nueva no tenia quien la matara.

const { spawnSync } = await import('node:child_process')
const { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { fileURLToPath } = await import('node:url')

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/** Copia lo que el oraculo necesita, aplica una perturbacion y lo corre ahi. El
 *  arbol de verdad no se toca: es un archivo versionado el que se rompe. */
function correrSobreCopia(perturbar) {
  const dir = mkdtempSync(join(tmpdir(), 'check-esquema-'))
  try {
    for (const x of ['herramientas', 'src', 'migraciones']) {
      cpSync(join(RAIZ, x), join(dir, x), { recursive: true })
    }
    perturbar(dir)
    const r = spawnSync(process.execPath, [join(dir, 'herramientas', 'check-esquema.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
    })
    return { codigo: r.status, salida: `${r.stdout}${r.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const MIGRACION = ['migraciones', 'core', '0001_cimientos.sql']

// Camino sano.
{
  const r = correrSobreCopia(() => {})
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /coinciden/)
}

// Un tipo de bolsa que le falta al CHECK: el defecto que esta herramienta existe
// para agarrar, comprobado a traves del proceso y no solo de la funcion pura.
{
  const r = correrSobreCopia((dir) => {
    const p = join(dir, ...MIGRACION)
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(
        "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion', 'retenido'))",
        "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion'))",
      ),
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /se desincronizaron/)
  assert.match(r.salida, /retenido/)
}

console.log('  check-esquema.pruebas: OK (incluidas las de punta a punta)')
