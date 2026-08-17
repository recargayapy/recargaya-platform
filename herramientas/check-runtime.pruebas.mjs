#!/usr/bin/env node
/**
 * Pruebas propias de check-runtime.mjs.
 *
 * Node plano, no vitest, por la misma razon que `check-esquema.pruebas.mjs`: es
 * la herramienta que prueba a la herramienta, y atar su verificacion a vitest
 * seria atarla a lo mismo que no la cubre.
 *
 * Casi todos los casos de abajo salieron de una auditoria adversarial que
 * encontro que el extractor anterior —una expresion regular sobre el texto que
 * descartaba las lineas que arrancaban con `//`— daba el resultado equivocado en
 * cinco configuraciones validas y realistas. Estan uno por uno, con el nombre
 * del caso, para que la proxima reescritura tenga que pasar por todos.
 *
 * Uso: node herramientas/check-runtime.pruebas.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normalizarJsonc,
  leerConfig,
  extraerEntornoDelArnes,
  fechaEfectiva,
  esFechaReal,
} from './check-runtime.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

// --- importar este modulo NO tiene que correr el oraculo -------------------
// Con el guard anterior (`argv[1].endsWith('check-runtime.mjs')`) esto ya era
// cierto, pero por casualidad: el nombre de ESTE archivo no termina asi. Ahora
// el guard es `import.meta.main` y la propiedad se afirma en vez de suponerse.
// Si `main()` corriera al importar, el `console.log` de mas abajo no seria la
// primera salida del proceso.
assert.equal(import.meta.main, true, 'este archivo se corre directo, no importado')

// --- normalizarJsonc -------------------------------------------------------

// Comentario de linea.
assert.equal(normalizarJsonc('{\n  // hola\n  "a": 1\n}').replace(/\s/g, ''), '{"a":1}')

// Comentario al final de una linea de codigo. ESTE es el caso que rompia el
// extractor viejo: contaba la fecha del comentario como una segunda fecha.
assert.equal(
  normalizarJsonc('{\n  "a": 1 // antes era 2\n}').replace(/\s/g, ''),
  '{"a":1}',
)

// Comentario de bloque, en una linea y en varias. El extractor viejo tomaba la
// fecha de adentro del bloque como si estuviera activa.
assert.equal(normalizarJsonc('{ /* nada */ "a": 1 }').replace(/\s/g, ''), '{"a":1}')
assert.equal(
  normalizarJsonc('{\n  /* antes decia\n     "a": 99\n  */\n  "a": 1\n}').replace(/\s/g, ''),
  '{"a":1}',
)

// Una barra doble ADENTRO de una cadena no es un comentario. Sin esto, una URL
// en la configuracion se comeria el resto de la linea.
assert.equal(
  normalizarJsonc('{ "url": "https://ejemplo.com/x", "a": 1 }').replace(/\s/g, ''),
  '{"url":"https://ejemplo.com/x","a":1}',
)
assert.equal(normalizarJsonc('{ "t": "/* no soy comentario */" }').includes('no soy'), true)

// Una comilla escapada no cierra la cadena.
assert.equal(
  normalizarJsonc('{ "t": "dijo \\"hola\\" // y se fue", "a": 1 }').replace(/\s/g, ''),
  '{"t":"dijo\\"hola\\"//ysefue","a":1}',
)

// Comas colgantes: JSONC las permite, JSON.parse no.
assert.deepEqual(leerConfig('{ "a": 1, }'), { a: 1 })
assert.deepEqual(leerConfig('{ "l": [1, 2, ] }'), { l: [1, 2] })
assert.deepEqual(leerConfig('{ "a": 1, // fin\n }'), { a: 1 })

// Una coma DENTRO de una cadena antes de un cierre no se toca.
assert.deepEqual(leerConfig('{ "t": "a," }'), { t: 'a,' })

// Un JSONC roto falla con un mensaje que dice que es de parseo, no con un
// `SyntaxError` pelado que no ubica a nadie.
assert.throws(() => leerConfig('{ "a": }'), /no se pudo parsear/)

// --- el wrangler.jsonc de verdad ------------------------------------------
// Esta es la unica prueba que toca el archivo real, y la version anterior era
// tautologica: verificaba con un regex que el resultado tuviera forma de fecha,
// cuando el grupo de captura del extractor ya garantizaba esa forma. No podia
// fallar. Ahora se compara contra el valor concreto.

const configReal = leerConfig(readFileSync(`${RAIZ}wrangler.jsonc`, 'utf8'))
assert.equal(configReal.compatibility_date, '2026-08-01')
assert.equal(configReal.name, 'recargaya')
assert.equal(configReal.env.staging.name, 'recargaya-staging')
assert.equal(configReal.env.produccion.workers_dev, false)

// --- extraerEntornoDelArnes ------------------------------------------------

const arnesReal = readFileSync(`${RAIZ}vitest.runtime.config.ts`, 'utf8')
assert.equal(extraerEntornoDelArnes(arnesReal), 'staging')

assert.equal(extraerEntornoDelArnes("wrangler: { environment: 'produccion' }"), 'produccion')
assert.equal(extraerEntornoDelArnes('wrangler: { environment: "staging" }'), 'staging')

// Un entorno nombrado en un comentario no cuenta.
assert.equal(
  extraerEntornoDelArnes("// antes: environment: 'produccion'\nwrangler: { environment: 'staging' }"),
  'staging',
)

assert.throws(() => extraerEntornoDelArnes('sin nada'), /no declara con que/)
assert.throws(
  () => extraerEntornoDelArnes("environment: 'staging'\nenvironment: 'produccion'"),
  /declara 2 entornos/,
)

// --- fechaEfectiva ---------------------------------------------------------

// Solo la raiz: es la que manda. Es la situacion de hoy.
assert.deepEqual(fechaEfectiva({ compatibility_date: '2026-08-01' }, 'staging'), {
  fecha: '2026-08-01',
  origen: 'raiz',
})

// El entorno gana sobre la raiz. El extractor viejo declaraba esto un conflicto
// irresoluble («no se sabe cual manda») y fallaba — pero wrangler sabe cual
// manda, y es una cosa que este proyecto podria querer perfectamente: subir la
// fecha en staging antes que en produccion.
assert.deepEqual(
  fechaEfectiva(
    { compatibility_date: '2026-08-01', env: { staging: { compatibility_date: '2026-08-10' } } },
    'staging',
  ),
  { fecha: '2026-08-10', origen: 'env.staging' },
)

// Y el override de OTRO entorno no se aplica al que corre.
assert.deepEqual(
  fechaEfectiva(
    { compatibility_date: '2026-08-01', env: { produccion: { compatibility_date: '2024-01-01' } } },
    'staging',
  ),
  { fecha: '2026-08-01', origen: 'raiz' },
)

// Solo el entorno, sin fecha en la raiz.
assert.deepEqual(
  fechaEfectiva({ env: { staging: { compatibility_date: '2026-08-10' } } }, 'staging'),
  { fecha: '2026-08-10', origen: 'env.staging' },
)

// EL CASO QUE ESTE ORACULO EXISTE PARA AGARRAR: no hay fecha en ningun lado, y
// miniflare va a poner la del reloj del sistema.
assert.deepEqual(fechaEfectiva({}, 'staging'), { fecha: null, origen: null })
assert.deepEqual(fechaEfectiva({ env: { staging: {} } }, 'staging'), { fecha: null, origen: null })
assert.deepEqual(
  fechaEfectiva({ env: { produccion: { compatibility_date: '2026-08-01' } } }, 'staging'),
  { fecha: null, origen: null },
)

// Config vacia o sin la forma esperada: `null`, no una excepcion. El que decide
// que hacer es `main()`, con su mensaje.
assert.deepEqual(fechaEfectiva(null, 'staging'), { fecha: null, origen: null })
assert.deepEqual(fechaEfectiva({ compatibility_date: 123 }, 'staging'), { fecha: null, origen: null })

// --- esFechaReal -----------------------------------------------------------

assert.equal(esFechaReal('2026-08-01'), true)
assert.equal(esFechaReal('2024-02-29'), true) // existe: 2024 es bisiesto

assert.equal(esFechaReal('2026-02-29'), false) // 2026 no es bisiesto
assert.equal(esFechaReal('2026-02-30'), false) // JavaScript la corre a 2026-03-02
assert.equal(esFechaReal('2026-13-45'), false)
assert.equal(esFechaReal('2026-08-00'), false)
assert.equal(esFechaReal('2026-8-1'), false) // sin ceros no es el formato
assert.equal(esFechaReal('manana'), false)
assert.equal(esFechaReal(''), false)
assert.equal(esFechaReal(null), false)
assert.equal(esFechaReal(20260801), false)

// --- de punta a punta, sobre arboles armados a mano ------------------------
// Las de arriba prueban las funciones. Estas prueban `main()`: que el oraculo
// salga con 1 en los casos que dice agarrar y con 0 cuando esta todo bien. Sin
// esto, el oraculo podia estar roto con sus propias pruebas en verde — que es
// exactamente lo que encontro la auditoria.

const { mkdtempSync, writeFileSync, cpSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { spawnSync } = await import('node:child_process')

/** Arma un arbol minimo con el oraculo adentro y lo corre. Devuelve el codigo de
 *  salida y la salida junta, para poder afirmar sobre el mensaje y no solo sobre
 *  el numero: un oraculo que falla con el mensaje equivocado manda a arreglar
 *  otra cosa. */
function correrOraculoCon({ wrangler, arnes }) {
  const dir = mkdtempSync(join(tmpdir(), 'check-runtime-'))
  try {
    cpSync(`${RAIZ}herramientas/check-runtime.mjs`, join(dir, 'herramientas', 'check-runtime.mjs'), {
      recursive: true,
    })
    writeFileSync(join(dir, 'wrangler.jsonc'), wrangler)
    writeFileSync(join(dir, 'vitest.runtime.config.ts'), arnes)

    // Se lo invoca desde OTRO directorio a proposito: el oraculo tiene que
    // resolver la raiz desde su propia ubicacion y no desde el cwd.
    const r = spawnSync(process.execPath, [join(dir, 'herramientas', 'check-runtime.mjs')], {
      cwd: tmpdir(),
      encoding: 'utf8',
    })
    return { codigo: r.status, salida: `${r.stdout}${r.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const ARNES_OK = "cloudflareTest({ wrangler: { configPath: './wrangler.jsonc', environment: 'staging' } })"

// Camino sano.
{
  const r = correrOraculoCon({ wrangler: '{ "compatibility_date": "2026-08-01" }', arnes: ARNES_OK })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /OK/)
  assert.match(r.salida, /staging/)
  assert.match(r.salida, /2026-08-01/)
}

// Sin fecha en ningun lado: el caso del reloj del sistema.
{
  const r = correrOraculoCon({ wrangler: '{ "name": "x" }', arnes: ARNES_OK })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO HAY compatibility_date/)
}

// La fecha existe pero solo dentro de un comentario de bloque. El extractor
// viejo la tomaba como valida y decia OK.
{
  const r = correrOraculoCon({
    wrangler: '{\n  /* antes: "compatibility_date": "2026-08-01" */\n  "name": "x"\n}',
    arnes: ARNES_OK,
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO HAY compatibility_date/)
}

// La fecha del entorno gana, y con eso alcanza aunque la raiz no tenga ninguna.
{
  const r = correrOraculoCon({
    wrangler: '{ "env": { "staging": { "compatibility_date": "2026-08-10" } } }',
    arnes: ARNES_OK,
  })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /2026-08-10/)
  assert.match(r.salida, /env\.staging/)
}

// Fecha que no existe.
{
  const r = correrOraculoCon({ wrangler: '{ "compatibility_date": "2026-02-30" }', arnes: ARNES_OK })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO ES UNA FECHA REAL/)
}

// El arnes no dice con que entorno corre: no se puede resolver nada.
{
  const r = correrOraculoCon({
    wrangler: '{ "compatibility_date": "2026-08-01" }',
    arnes: 'cloudflareTest({})',
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO SE PUDO DETERMINAR/)
}

// wrangler.jsonc ilegible: falla con el mensaje del oraculo, no con un stack.
{
  const r = correrOraculoCon({ wrangler: '{ "compatibility_date": }', arnes: ARNES_OK })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO SE PUDO DETERMINAR/)
  assert.doesNotMatch(r.salida, /at main \(/)
}

// El arnes apunta a un entorno que la configuracion no declara: se cae a la
// fecha de la raiz, que es lo que hace wrangler, y eso esta bien.
{
  const r = correrOraculoCon({
    wrangler: '{ "compatibility_date": "2026-08-01", "env": { "staging": {} } }',
    arnes: "cloudflareTest({ wrangler: { environment: 'inventado' } })",
  })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /inventado/)
}

console.log('  check-runtime.pruebas: OK')
