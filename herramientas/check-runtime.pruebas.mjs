#!/usr/bin/env node
/**
 * Pruebas propias de check-runtime.mjs.
 *
 * Node plano, no vitest, por la misma razon que `check-esquema.pruebas.mjs`: es
 * la herramienta que prueba a la herramienta, y atar su verificacion a vitest
 * seria atarla a lo mismo que no la cubre.
 *
 * Muchos de los casos de abajo salieron de auditorias adversariales: el extractor
 * original —una expresion regular sobre el texto que descartaba las lineas que
 * arrancaban con `//`— daba el resultado equivocado en tres CLASES de error, que
 * se manifestaban en cinco configuraciones validas y realistas. Estan uno por uno
 * para que la proxima reescritura tenga que pasar por todos.
 *
 * Uso: node herramientas/check-runtime.pruebas.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normalizarJsonc,
  leerConfig,
  buscarFechaImpuestaPorElArnes,
  fechaEfectiva,
  esFechaReal,
} from './check-runtime.mjs'
import { leerArnes } from './arnes-del-runtime.mjs'
import { invocadoDirecto } from './invocado-directo.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

// --- el guard del CLI ------------------------------------------------------
// Este archivo se corre directo, y el modulo que importa NO. Si el guard diera
// verdadero al importar, `main()` correria aca y el `console.log` del final no
// seria la ultima palabra del proceso.
assert.equal(invocadoDirecto(import.meta), true, 'este archivo se corre directo')
// Y un modulo importado NO se cree invocado. Se le pasa un `meta` sin `main`
// —que es lo que ve un Node anterior a la 22.18— para ejercitar el respaldo por
// comparacion de rutas y no solo el camino de `import.meta.main`.
assert.equal(
  invocadoDirecto({ url: new URL('check-runtime.mjs', import.meta.url).href }),
  false,
  'el modulo importado no se cree invocado',
)
// Y una procedencia que no se puede resolver responde `false`, no `true`: un
// modulo importado que no sabe de donde viene no arranca un oraculo por las
// dudas. La version anterior devolvia `true` aca, y por eso `main()` corria
// adentro del import de `generar-tipos.mjs`.
assert.equal(invocadoDirecto({ url: 'file:///no/existe/nada.mjs' }), false)

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

// --- leerArnes -------------------------------------------------------------
// Es un JSON, asi que no hay parser propio que probar. Lo que se prueba es que el
// archivo REAL diga lo que el resto de la entrega supone, y que cada forma
// invalida falle con un mensaje en vez de resolver a `undefined`.

assert.deepEqual(leerArnes(readFileSync(`${RAIZ}pruebas-runtime/arnes-del-runtime.json`, 'utf8')), {
  environment: 'staging',
  configPath: './wrangler.jsonc',
})

assert.deepEqual(leerArnes('{ "environment": "produccion", "configPath": "./wrangler.jsonc" }'), {
  environment: 'produccion',
  configPath: './wrangler.jsonc',
})

assert.throws(() => leerArnes('{ "configPath": "./wrangler.jsonc" }'), /no declara un `environment`/)
assert.throws(
  () => leerArnes('{ "environment": "", "configPath": "./wrangler.jsonc" }'),
  /no declara un `environment`/,
)
assert.throws(
  () => leerArnes('{ "environment": 3, "configPath": "./wrangler.jsonc" }'),
  /no declara un `environment`/,
)
assert.throws(() => leerArnes('no soy json'), /no es JSON valido/)

// El configPath tiene que ser el wrangler.jsonc del proyecto. Era el agujero
// grande de esta familia: con el arnes apuntado a otra configuracion, los oraculos
// aprobaban un archivo que las pruebas no leian. Medido antes del arreglo: con un
// `configPath` a una copia de fecha 2023, el oraculo firmaba 2026-08-01.
assert.throws(() => leerArnes('{ "environment": "staging" }'), /configPath "undefined"/)
assert.throws(
  () => leerArnes('{ "environment": "staging", "configPath": "./otro.jsonc" }'),
  /tiene que ser "\.\/wrangler\.jsonc"/,
)

// --- buscarFechaImpuestaPorElArnes ----------------------------------------
// El bloque `miniflare: {}` del pool es un objeto laxo: TypeScript no revisa lo
// que va adentro, y un `compatibilityDate` ahi gana sobre todo lo que este
// oraculo resuelve. No se resuelve: se prohibe.

const arnesReal = readFileSync(`${RAIZ}vitest.runtime.config.ts`, 'utf8')
assert.equal(buscarFechaImpuestaPorElArnes(arnesReal), null)

assert.equal(
  buscarFechaImpuestaPorElArnes("miniflare: { compatibilityDate: '2023-01-01' }"),
  'compatibilityDate',
)
assert.equal(
  buscarFechaImpuestaPorElArnes('miniflare: { compatibility_date: "2023-01-01" }'),
  'compatibility_date',
)
assert.equal(buscarFechaImpuestaPorElArnes('nada de eso aca'), null)

// Un COMENTARIO que la menciona no impone nada. La version anterior era un grep
// sobre todo el texto, y una auditoria la rompio con el comentario mas natural que
// existe: el que documenta esta misma regla. El oraculo se ponia en rojo acusando
// al archivo de hacer exactamente lo que el comentario dice no hacer.
assert.equal(
  buscarFechaImpuestaPorElArnes('// OJO: aca NO va un miniflare.compatibilityDate: lo prohibe el oraculo'),
  null,
)
assert.equal(
  buscarFechaImpuestaPorElArnes(' * `compatibilityDate:` gana sobre wrangler.jsonc'),
  null,
)
assert.equal(buscarFechaImpuestaPorElArnes('/* compatibilityDate: nada */'), null)

// Pero una linea de codigo si, aunque venga con un comentario al final.
assert.equal(
  buscarFechaImpuestaPorElArnes("      compatibilityDate: '2023-01-01', // temporal"),
  'compatibilityDate',
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

const { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { spawnSync } = await import('node:child_process')

/** Arma un arbol minimo con el oraculo adentro y lo corre. Devuelve el codigo de
 *  salida y la salida junta, para poder afirmar sobre el mensaje y no solo sobre
 *  el numero: un oraculo que falla con el mensaje equivocado manda a arreglar
 *  otra cosa. */
function correrOraculoCon({
  wrangler,
  entorno = '{ "environment": "staging", "configPath": "./wrangler.jsonc" }',
  arnes = ARNES_OK,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-runtime-'))
  try {
    cpSync(`${RAIZ}herramientas`, join(dir, 'herramientas'), { recursive: true })
    writeFileSync(join(dir, 'wrangler.jsonc'), wrangler)
    writeFileSync(join(dir, 'vitest.runtime.config.ts'), arnes)
    mkdirSync(join(dir, 'pruebas-runtime'), { recursive: true })
    writeFileSync(join(dir, 'pruebas-runtime', 'arnes-del-runtime.json'), entorno)

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

const ARNES_OK = "cloudflareTest({ wrangler: { configPath: arnes.configPath, environment: arnes.environment } })"

const CON_STAGING = '{ "compatibility_date": "2026-08-01", "env": { "staging": { "name": "x" } } }'

// Camino sano.
{
  const r = correrOraculoCon({ wrangler: CON_STAGING })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /OK/)
  assert.match(r.salida, /staging/)
  assert.match(r.salida, /2026-08-01/)
}

// Sin fecha en ningun lado: el caso del reloj del sistema.
{
  const r = correrOraculoCon({ wrangler: '{ "name": "x", "env": { "staging": {} } }' })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO HAY compatibility_date/)
}

// La fecha existe pero solo dentro de un comentario de bloque. El extractor
// viejo la tomaba como valida y decia OK.
{
  const r = correrOraculoCon({
    wrangler:
      '{\n  /* antes: "compatibility_date": "2026-08-01" */\n  "name": "x",\n  "env": { "staging": {} }\n}',
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO HAY compatibility_date/)
}

// La fecha del entorno gana, y con eso alcanza aunque la raiz no tenga ninguna.
{
  const r = correrOraculoCon({
    wrangler: '{ "env": { "staging": { "compatibility_date": "2026-08-10" } } }',
  })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /2026-08-10/)
  assert.match(r.salida, /env\.staging/)
}

// Fecha que no existe.
{
  const r = correrOraculoCon({
    wrangler: '{ "compatibility_date": "2026-02-30", "env": { "staging": {} } }',
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO ES UNA FECHA REAL/)
}

// El archivo de datos no dice con que entorno corre.
{
  const r = correrOraculoCon({ wrangler: CON_STAGING, entorno: '{}' })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO SE PUDO DETERMINAR/)
}

// El arnes apunta a OTRA configuracion: los oraculos aprobarian un archivo que las
// pruebas no leen.
{
  const r = correrOraculoCon({
    wrangler: CON_STAGING,
    entorno: '{ "environment": "staging", "configPath": "./otro-wrangler.jsonc" }',
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /configPath/)
}

// El arnes impone la fecha con una linea de codigo: la efectiva deja de ser la
// aprobada.
{
  const r = correrOraculoCon({
    wrangler: CON_STAGING,
    arnes: `${ARNES_OK}\n      compatibilityDate: '2023-01-01',`,
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /linea de codigo con `compatibilityDate:`/)
}

// Pero un comentario que la menciona NO rompe el CI. Es el caso que una auditoria
// uso para voltear la version anterior de esta regla.
{
  const r = correrOraculoCon({
    wrangler: CON_STAGING,
    arnes: `${ARNES_OK}\n      // OJO: nada de miniflare.compatibilityDate aca.`,
  })
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
}

// wrangler.jsonc ilegible: falla con el mensaje del oraculo, no con un stack.
{
  const r = correrOraculoCon({ wrangler: '{ "compatibility_date": }' })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO SE PUDO DETERMINAR/)
  assert.doesNotMatch(r.salida, /at main \(/)
}

// El arnes apunta a un entorno que la configuracion no declara. Antes esto daba
// OK resolviendo contra la fecha de la raiz: un veredicto sobre un entorno que no
// existe, con la palabra OK arriba. Ahora falla.
{
  const r = correrOraculoCon({
    wrangler: '{ "compatibility_date": "2026-08-01", "env": { "staging": {} } }',
    entorno: '{ "environment": "inventado", "configPath": "./wrangler.jsonc" }',
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /no declara el entorno "inventado"/)
}

// Invocado por DIRECTORIO, con un package.json que declara `main`. Es el unico
// caso donde `import.meta.main` y la comparacion de rutas no coinciden: Node pone
// el DIRECTORIO en `argv[1]`, asi que el respaldo por rutas responde `false` y el
// oraculo saldria con 0 sin verificar nada — el mismo final que el guard por nombre
// que empezo todo esto. La rama de `import.meta.main` existe exactamente para esto,
// y sin este caso su mutacion sobrevivia.
{
  const dir = mkdtempSync(join(tmpdir(), 'check-runtime-dir-'))
  try {
    cpSync(`${RAIZ}herramientas`, join(dir, 'oraculo'), { recursive: true })
    writeFileSync(join(dir, 'wrangler.jsonc'), CON_STAGING)
    writeFileSync(join(dir, 'vitest.runtime.config.ts'), ARNES_OK)
    mkdirSync(join(dir, 'pruebas-runtime'), { recursive: true })
    writeFileSync(
      join(dir, 'pruebas-runtime', 'arnes-del-runtime.json'),
      '{ "environment": "staging", "configPath": "./wrangler.jsonc" }',
    )
    writeFileSync(
      join(dir, 'oraculo', 'package.json'),
      '{ "type": "module", "main": "check-runtime.mjs" }',
    )

    const r = spawnSync(process.execPath, [join(dir, 'oraculo')], { cwd: tmpdir(), encoding: 'utf8' })
    const salida = `${r.stdout}${r.stderr}`
    assert.equal(r.status, 0, `esperaba 0 y salio ${r.status}: ${salida}`)
    assert.match(salida, /OK/, `invocado por directorio no verifico nada: ${JSON.stringify(salida)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('  check-runtime.pruebas: OK')
