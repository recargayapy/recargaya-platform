#!/usr/bin/env node
/**
 * Pruebas propias de check-entorno.mjs.
 *
 * Node plano, no vitest, por la misma razon que las otras dos: es la herramienta
 * que prueba a la herramienta.
 *
 * Uso: node herramientas/check-entorno.pruebas.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { compararGenerado, ARGUMENTOS } from './check-entorno.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

assert.equal(import.meta.main, true)

// --- la comparacion, pura --------------------------------------------------

assert.deepEqual(compararGenerado('a\nb\n', 'a\nb\n'), {
  ok: true,
  lineaDistinta: null,
  esperada: null,
  encontrada: null,
})

// El final de linea no puede cambiar el veredicto: el defecto n.º 6 de la Fase 0
// fue el mismo commit fallando en Windows y pasando en el CI.
assert.equal(compararGenerado('a\r\nb\r\n', 'a\nb\n').ok, true)

// Ni el salto de linea final.
assert.equal(compararGenerado('a\nb', 'a\nb\n\n').ok, true)

// Una linea distinta se reporta con su numero y las dos versiones, porque el que
// lee esto tiene el CI en rojo y necesita saber QUE cambio.
assert.deepEqual(compararGenerado('a\nX\nc\n', 'a\nb\nc\n'), {
  ok: false,
  lineaDistinta: 2,
  esperada: 'b',
  encontrada: 'X',
})

// Una linea agregada en el repositorio.
assert.deepEqual(compararGenerado('a\nb\nc\n', 'a\nb\n'), {
  ok: false,
  lineaDistinta: 3,
  esperada: '(no existe)',
  encontrada: 'c',
})

// Una linea que falta en el repositorio.
assert.deepEqual(compararGenerado('a\n', 'a\nb\n'), {
  ok: false,
  lineaDistinta: 2,
  esperada: 'b',
  encontrada: '(no existe)',
})

// Un cambio de espacios en el MEDIO de una linea si cuenta: el archivo generado
// usa tabulaciones, y "normalizar" mas que el fin de linea seria un oraculo mas
// permisivo que el generador.
assert.equal(compararGenerado('\tCORE: D1Database;\n', '    CORE: D1Database;\n').ok, false)

// --- de punta a punta ------------------------------------------------------
// Sin esto, el oraculo podia estar roto con sus pruebas en verde — que es lo que
// una auditoria encontro en la version anterior de `check-runtime.pruebas.mjs`.

const GENERADO = join(RAIZ, 'worker-configuration.d.ts')
const RESPALDO = join(RAIZ, 'worker-configuration.d.ts.respaldo-de-pruebas')

function correrOraculo() {
  const r = spawnSync(process.execPath, [join(RAIZ, 'herramientas', 'check-entorno.mjs')], {
    // Desde otro directorio a proposito: el oraculo resuelve la raiz desde su
    // propia ubicacion, no desde el cwd.
    cwd: '/',
    encoding: 'utf8',
  })
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` }
}

copyFileSync(GENERADO, RESPALDO)
try {
  // Camino sano: el archivo del repositorio coincide con lo que genera wrangler.
  {
    const r = correrOraculo()
    assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
    assert.match(r.salida, /OK/)
  }

  // Editado a mano. Este es el caso que `wrangler types --check` NO agarra:
  // medido, sale 0 porque compara un hash de la configuracion y no el contenido.
  {
    const original = readFileSync(GENERADO, 'utf8')
    writeFileSync(GENERADO, original.replace('CORE: D1Database;', 'CORE: D1Database; // tocado'))
    const r = correrOraculo()
    assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
    assert.match(r.salida, /NO COINCIDE CON wrangler\.jsonc/)
    assert.match(r.salida, /tocado/)
    copyFileSync(RESPALDO, GENERADO)
  }

  // Un binding sacado a mano: el caso en que el codigo compila contra menos de
  // lo que hay, y despues alguien lo "arregla" escribiendolo en `Entorno`.
  {
    const original = readFileSync(GENERADO, 'utf8')
    writeFileSync(GENERADO, original.replace(/\tSECUENCIA: [^\n]*\n/, ''))
    const r = correrOraculo()
    assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
    assert.match(r.salida, /NO COINCIDE/)
    copyFileSync(RESPALDO, GENERADO)
  }

  // El archivo no existe.
  {
    rmSync(GENERADO)
    const r = correrOraculo()
    assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
    assert.match(r.salida, /FALTA worker-configuration\.d\.ts/)
    assert.match(r.salida, new RegExp(ARGUMENTOS.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    copyFileSync(RESPALDO, GENERADO)
  }

  // Y queda como estaba.
  {
    const r = correrOraculo()
    assert.equal(r.codigo, 0, `el arbol no quedo como estaba: ${r.salida}`)
  }
} finally {
  copyFileSync(RESPALDO, GENERADO)
  rmSync(RESPALDO, { force: true })
}

console.log('  check-entorno.pruebas: OK')
