#!/usr/bin/env node
/**
 * Pruebas propias de check-runtime.mjs.
 *
 * Node plano, no vitest, por la misma razon que `check-esquema.pruebas.mjs`: es
 * la herramienta que prueba a la herramienta, y atar su verificacion a vitest
 * seria atarla a lo mismo que no la cubre.
 *
 * Uso: node herramientas/check-runtime.pruebas.mjs
 */

import assert from 'node:assert/strict'
import {
  extraerFechaCompatibilidad,
  fechaDeWorkerd,
  compararRuntime,
} from './check-runtime.mjs'

// --- el veredicto ----------------------------------------------------------

// La fecha pedida es anterior al motor: es el caso correcto y el unico normal.
assert.deepEqual(compararRuntime('2026-08-01', '2026-08-11'), {
  ok: true,
  fechaCompatibilidad: '2026-08-01',
  fechaWorkerd: '2026-08-11',
})

// Iguales: tambien correcto. El limite se incluye.
assert.equal(compararRuntime('2026-08-11', '2026-08-11').ok, true)

// Esto es lo que el oraculo existe para agarrar: pedimos una fecha que el motor
// instalado no conoce, y miniflare la bajaria sin fallar.
assert.deepEqual(compararRuntime('2026-08-01', '2025-09-06'), {
  ok: false,
  fechaCompatibilidad: '2026-08-01',
  fechaWorkerd: '2025-09-06',
})

// Un dia de diferencia alcanza. Un oraculo con tolerancia no es un oraculo.
assert.equal(compararRuntime('2026-08-12', '2026-08-11').ok, false)

// --- la version de workerd -------------------------------------------------

assert.equal(fechaDeWorkerd('1.20260811.1'), '2026-08-11')
assert.equal(fechaDeWorkerd('1.20250906.0'), '2025-09-06')

// El prelanzamiento se acepta: es la forma en que se publica hoy la linea nueva
// de miniflare, y rechazarlo seria una falsa alarma sobre lo que wrangler
// instala. La fecha se lee igual.
assert.equal(fechaDeWorkerd('1.20260811.1-alpha'), '2026-08-11')
assert.equal(fechaDeWorkerd('1.20260811.1-beta.2'), '2026-08-11')

assert.throws(() => fechaDeWorkerd('1.2026.0'), /no tiene el formato/)
assert.throws(() => fechaDeWorkerd(''), /no tiene el formato/)

// Basura pegada al final. Sin el ancla, esto pasaba y devolvia una fecha.
assert.throws(() => fechaDeWorkerd('1.20260811.1 y algo mas'), /no tiene el formato/)

// Fechas que no existen. `2026-02-30` es el caso peligroso: JavaScript no falla,
// la corre a 2026-03-02 en silencio. Un oraculo que compara contra una fecha
// corrida dos dias es peor que uno que no corre.
assert.throws(() => fechaDeWorkerd('1.20261345.0'), /no codifica una fecha real/)
assert.throws(() => fechaDeWorkerd('1.20260230.0'), /no codifica una fecha real/)
assert.throws(() => fechaDeWorkerd('1.20260229.0'), /no codifica una fecha real/)
assert.throws(() => fechaDeWorkerd('1.20260800.0'), /no codifica una fecha real/)

// Un 29 de febrero que SI existe se acepta. Si esta fallara, la comprobacion de
// fecha estaria rechazando fechas validas.
assert.equal(fechaDeWorkerd('1.20240229.0'), '2024-02-29')

// --- la fecha de wrangler.jsonc -------------------------------------------

assert.equal(
  extraerFechaCompatibilidad('{\n  "compatibility_date": "2026-08-01",\n}\n'),
  '2026-08-01',
)

// Con comentarios de linea alrededor, que es como esta el archivo de verdad.
assert.equal(
  extraerFechaCompatibilidad(
    '{\n  // la fecha manda\n  "compatibility_date": "2026-08-01",\n}\n',
  ),
  '2026-08-01',
)

// Un comentario de linea que nombra una fecha vieja NO puede ganar.
assert.equal(
  extraerFechaCompatibilidad(
    '{\n  // antes decia "compatibility_date": "2024-01-01"\n  "compatibility_date": "2026-08-01",\n}\n',
  ),
  '2026-08-01',
)

// Dos fechas activas: no se elige una, se falla. Cual manda no lo puede
// adivinar una expresion regular, y adivinar es lo que produce el defecto.
assert.throws(
  () =>
    extraerFechaCompatibilidad(
      '{\n  "compatibility_date": "2026-08-01",\n  "env": { "staging": { "compatibility_date": "2024-01-01" } }\n}\n',
    ),
  /se encontraron 2/,
)

assert.throws(() => extraerFechaCompatibilidad('{}\n'), /no se encontro/)

// El formato tiene que ser una fecha, no cualquier texto.
assert.throws(
  () => extraerFechaCompatibilidad('{\n  "compatibility_date": "manana",\n}\n'),
  /no se encontro/,
)

// --- el archivo de verdad --------------------------------------------------
// Las de arriba prueban la funcion sobre texto inventado. Esta prueba que la
// funcion sirve para el archivo que realmente tiene que leer: un extractor que
// pasa todas sus pruebas sinteticas y no encuentra nada en el wrangler.jsonc
// real no sirve para nada.

const { readFileSync } = await import('node:fs')
const fecha = extraerFechaCompatibilidad(readFileSync('wrangler.jsonc', 'utf8'))
assert.match(fecha, /^\d{4}-\d{2}-\d{2}$/)

console.log('  check-runtime.pruebas: OK')
