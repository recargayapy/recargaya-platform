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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { compararGenerado, argumentos } from './check-entorno.mjs'
import { invocadoDirecto } from './invocado-directo.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

assert.equal(invocadoDirecto(import.meta), true)

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

// --- de punta a punta, sobre una COPIA ------------------------------------
// La version anterior de estas pruebas corria sobre el arbol de verdad: editaba
// `worker-configuration.d.ts` —un archivo versionado—, lo restauraba desde un
// respaldo que no estaba en .gitignore, y se apoyaba en un `finally` para
// limpiar. La segunda vuelta de auditoria midio la ventana: el archivo quedaba
// corrompido unos 2,5 segundos por corrida, y un Ctrl-C en el medio dejaba el
// arbol sucio con un `.d.ts` versionado roto y un respaldo huerfano sin ignorar.
//
// Ahora se copia lo necesario a un temporal, con `node_modules` enlazado para que
// `npx wrangler` resuelva, y se rompe ahi. El arbol de verdad no se toca nunca —
// es el mismo patron que ya usaba `check-runtime.pruebas.mjs`.

const { mkdtempSync, cpSync, symlinkSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { spawnSync } = await import('node:child_process')

/** Arma una copia del arbol con lo que `check-entorno.mjs` necesita, aplica una
 *  perturbacion, y corre el oraculo ahi. */
function correrOraculoSobreCopia(perturbar) {
  const dir = mkdtempSync(join(tmpdir(), 'check-entorno-'))
  try {
    // Si el oraculo crece y necesita otro archivo, agregalo a esta lista: la
    // prueba va a fallar con un ENOENT que nombra la ruta completa dentro del
    // temporal, que es diagnosticable de una lectura.
    for (const x of ['herramientas', 'src', 'pruebas-runtime', 'wrangler.jsonc', 'package.json']) {
      cpSync(join(RAIZ, x), join(dir, x), { recursive: true })
    }
    cpSync(join(RAIZ, 'worker-configuration.d.ts'), join(dir, 'worker-configuration.d.ts'))
    symlinkSync(join(RAIZ, 'node_modules'), join(dir, 'node_modules'))

    perturbar(dir)

    const r = spawnSync(process.execPath, [join(dir, 'herramientas', 'check-entorno.mjs')], {
      // Desde otro directorio a proposito: el oraculo resuelve la raiz desde su
      // propia ubicacion, no desde el cwd.
      cwd: tmpdir(),
      encoding: 'utf8',
    })
    return {
      codigo: r.status,
      salida: `${r.stdout}${r.stderr}`,
      // Que no deje basura: ni el temporal ni ningun rastro.
      temporales: readdirSync(dir).filter((f) => f.startsWith('.check-entorno.')),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const { readdirSync, writeFileSync } = await import('node:fs')
const generado = (dir) => join(dir, 'worker-configuration.d.ts')

// Camino sano.
{
  const r = correrOraculoSobreCopia(() => {})
  assert.equal(r.codigo, 0, `esperaba 0 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /OK/)
  assert.deepEqual(r.temporales, [], 'el camino sano no deja temporales')
}

// Editado a mano. Este es el caso que `wrangler types --check` NO agarra: medido,
// sale 0 porque compara un hash de la configuracion y no el contenido.
{
  const r = correrOraculoSobreCopia((dir) => {
    const original = readFileSync(generado(dir), 'utf8')
    writeFileSync(generado(dir), original.replace('CORE: D1Database;', 'CORE: D1Database; // tocado'))
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO COINCIDE CON wrangler\.jsonc/)
  assert.match(r.salida, /tocado/)
  // Y en el camino de FALLA tampoco deja el temporal. Es la razon por la que los
  // `process.exit` viven afuera del `try`: `process.exit()` no corre el `finally`.
  assert.deepEqual(r.temporales, [], 'el camino de falla tampoco deja temporales')
}

// Un binding sacado a mano: el caso en que el codigo compila contra menos de lo
// que hay, y despues alguien lo "arregla" escribiendolo en `Entorno`.
{
  const r = correrOraculoSobreCopia((dir) => {
    const original = readFileSync(generado(dir), 'utf8')
    writeFileSync(generado(dir), original.replace(/\tSECUENCIA: [^\n]*\n/, ''))
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO COINCIDE/)
}

// La configuracion cambio y nadie regenero.
{
  const r = correrOraculoSobreCopia((dir) => {
    const w = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')
    writeFileSync(
      join(dir, 'wrangler.jsonc'),
      w.replace('"ZONA_HORARIA": "America/Asuncion"', '"ZONA_HORARIA": "America/Asuncion",\n        "CLAVE_NUEVA": "x"'),
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NO COINCIDE/)
  assert.match(r.salida, /CLAVE_NUEVA/)
}

// El archivo no existe.
{
  const r = correrOraculoSobreCopia((dir) => rmSync(generado(dir)))
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /FALTA worker-configuration\.d\.ts/)
  assert.match(r.salida, /npm run tipos:generar/)
}

// El arbol de verdad sigue pasando el oraculo.
//
// Ojo con lo que esto prueba y lo que no, porque la version anterior de este
// comentario prometia mas: afirmaba «el arbol de verdad quedo intacto: ninguna de
// las perturbaciones lo toco», y el oraculo mira UNA cosa —que
// `worker-configuration.d.ts` coincida con los tipos del entorno del arnes—. Es
// ciego a `src/`, a `package.json` y a casi todo `wrangler.jsonc`. La garantia de
// que el arbol real no se toca la da que las perturbaciones ocurren sobre una
// copia, no esta asercion.
{
  const r = spawnSync(process.execPath, [join(RAIZ, 'herramientas', 'check-entorno.mjs')], {
    cwd: tmpdir(),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `el arbol de verdad dejo de pasar el oraculo: ${r.stdout}${r.stderr}`)
}

// Y los argumentos de generacion llevan el entorno que se les pasa, no uno fijo.
assert.equal(argumentos('produccion').includes('produccion'), true)
assert.equal(argumentos('staging').includes('produccion'), false)
// Sin `--strict-vars=false`: sin los literales de las vars, `--env staging` y
// `--env produccion` generan el archivo byte a byte identico y el oraculo queda
// ciego al entorno. Lo midio la tercera vuelta de auditoria.
assert.equal(argumentos('staging').includes('--strict-vars=false'), false)

console.log('  check-entorno.pruebas: OK')
