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

console.log('  check-esquema.pruebas: OK')
