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
import {
  compararEsquemas,
  compararOrden,
  extraerTipoBolsa,
  extraerCheckBolsa,
  extraerTiposDelEsquemaDO,
} from './check-esquema.mjs'

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

// --- la tercera frontera: el esquema del Durable Object -------------------

assert.deepEqual(
  extraerTiposDelEsquemaDO(
    "export const TIPOS_DE_BOLSA = [\n  'disponible',\n  'retenido',\n] as const\n",
  ),
  ['disponible', 'retenido'],
)

assert.deepEqual(
  extraerTiposDelEsquemaDO("export const TIPOS_DE_BOLSA = ['a'] as const"),
  ['a'],
)

assert.throws(() => extraerTiposDelEsquemaDO('nada por aca'), /no se encontro/)

// El orden importa entre TypeScript y el DO, porque la lista del DO se interpola
// dentro de los CHECK del DDL.
assert.equal(compararOrden(['a', 'b'], ['a', 'b']).ok, true)
assert.equal(compararOrden(['a', 'b'], ['b', 'a']).ok, false)
assert.deepEqual(compararOrden(['a', 'b'], ['b', 'a']), {
  ok: false,
  tipos: ['a', 'b'],
  delDO: ['b', 'a'],
})



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
    // Si el oraculo crece y necesita otro archivo, agregalo a esta lista.
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

// Un tipo de bolsa que le falta al esquema del DO. Es la frontera nueva, y la mas
// peligrosa: gobierna la tabla donde nace el asiento.
{
  const r = correrSobreCopia((dir) => {
    const p = join(dir, 'src', 'billetera', 'esquema.ts')
    writeFileSync(p, readFileSync(p, 'utf8').replace("  'retenido',\n", ''))
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /esquema del Durable Object se desincronizaron/)
  assert.match(r.salida, /retenido/)
}

// Los mismos tipos en distinto orden: no rompe ninguna operacion, pero cambia el
// DDL generado, y se reporta aparte para no confundirlo con un descuadre.
{
  const r = correrSobreCopia((dir) => {
    const p = join(dir, 'src', 'billetera', 'esquema.ts')
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(
        "  'disponible',\n  'ganancia_creador',",
        "  'ganancia_creador',\n  'disponible',",
      ),
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /DISTINTO ORDEN/)
}

// LA MISMA ROTURA, PERO EN LA ULTIMA MIGRACION Y NO EN LA PRIMERA.
//
// Lo pidio el arnes de mutacion: `enSql.slice(0, 1)` —o sea, mirar solo la primera
// migracion, que era literalmente lo que hacia la version anterior de
// `check-esquema.mjs` con la ruta a `0001_cimientos.sql` escrita a mano—
// SOBREVIVIO. Y no es teorico: 0002 reconstruye `ledger_copia` para arreglarle la
// clave primaria, asi que el CHECK que gobierna de verdad es el ULTIMO, no el
// primero. El oraculo estaba aprobando la definicion de una tabla que ya no existe.
//
// Se perturba "la ultima" y no "0002" por nombre: cuando llegue 0003, esta prueba
// tiene que seguir apuntando a la que manda.
{
  const { readdirSync } = await import('node:fs')
  const r = correrSobreCopia((dir) => {
    const carpeta = join(dir, 'migraciones', 'core')
    const ultima = readdirSync(carpeta).filter((n) => n.endsWith('.sql')).sort().pop()
    const p = join(carpeta, ultima)
    const texto = readFileSync(p, 'utf8')
    assert.match(texto, /CHECK \(bolsa IN/, `${ultima} no declara ningun CHECK de bolsa`)
    writeFileSync(
      p,
      texto.replace(
        "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion', 'retenido'))",
        "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion'))",
      ),
    )
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /se desincronizaron/)
  assert.match(r.salida, /retenido/)
}

// Y si NINGUNA migracion declara el CHECK, el oraculo tiene que fallar en vez de
// decir OK sin haber comparado nada. Es la forma que tomaria un cambio en como se
// escribe la columna: la expresion regular deja de encontrarla, la lista queda
// vacia, y un bucle sobre una lista vacia no se queja.
{
  const { readdirSync } = await import('node:fs')
  const r = correrSobreCopia((dir) => {
    const carpeta = join(dir, 'migraciones', 'core')
    for (const n of readdirSync(carpeta).filter((x) => x.endsWith('.sql'))) {
      const p = join(carpeta, n)
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll('CHECK (bolsa IN', 'CHECK (bolsita IN'))
    }
  })
  assert.equal(r.codigo, 1, `esperaba 1 y salio ${r.codigo}: ${r.salida}`)
  assert.match(r.salida, /NINGUNA migracion/)
}

console.log('  check-esquema.pruebas: OK (incluidas las de punta a punta)')
