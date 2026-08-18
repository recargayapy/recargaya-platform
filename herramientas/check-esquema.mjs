#!/usr/bin/env node
/**
 * Compara los valores de TipoBolsa (TypeScript) contra el CHECK de la
 * columna `bolsa` en la migracion que copia el ledger (SQL).
 *
 * El defecto que motiva esto: `retenido` se agrego a TipoBolsa y nadie lo
 * agrego al CHECK de `ledger_copia`. `npm run verificar` no lo agarraba
 * porque tipos, pruebas y mutacion corren todos sobre TypeScript — el CHECK
 * vive del otro lado de esa frontera, en SQL. Esta herramienta existe para
 * que la proxima vez que un tipo de bolsa se agregue en un solo lado, algo
 * falle ruidosamente antes de produccion.
 *
 * Uso: node herramientas/check-esquema.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invocadoDirecto } from './invocado-directo.mjs'

// La raiz sale de la ubicacion de este archivo y no del directorio desde el que
// se lo invoca. Antes eran rutas relativas al cwd: corrido desde `herramientas/`
// moria con un ENOENT y un stack pelado. Un oraculo cuyo veredicto depende de
// donde estabas parado es lo mismo que el defecto n.º 6 de la Fase 0 con otro
// disfraz. Los otros dos oraculos ya lo resolvian asi; este quedo atras.
const RAIZ = fileURLToPath(new URL('..', import.meta.url))
const ARCHIVO_TIPOS = join(RAIZ, 'src', 'dinero', 'bolsas.ts')
const DIR_MIGRACIONES = join(RAIZ, 'migraciones', 'core')
const ARCHIVO_ESQUEMA_DO = join(RAIZ, 'src', 'billetera', 'esquema.ts')

export function extraerTipoBolsa(contenido) {
  const m = contenido.match(/export type TipoBolsa = ([^\n]+)/)
  if (m === null) throw new Error('no se encontro "export type TipoBolsa" en el archivo')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/**
 * TODOS los CHECK de la columna `bolsa` que declare un archivo SQL.
 *
 * Va en plural desde que las migraciones son mas de una, y no es un detalle de
 * forma: la version anterior leia SOLO `0001_cimientos.sql` con la ruta escrita a
 * mano. La migracion 0002 reconstruye `ledger_copia` —para arreglarle la clave
 * primaria— y con ella la columna `bolsa` y su CHECK. O sea que el oraculo habria
 * seguido aprobando la definicion de una tabla que ya no existe, mientras la que
 * gobierna de verdad quedaba sin comparar contra nada.
 *
 * Es exactamente la clase de defecto que este archivo existe para agarrar, con el
 * oraculo del lado equivocado.
 */
export function extraerChecksBolsa(contenido) {
  return [...contenido.matchAll(/bolsa\s+TEXT NOT NULL CHECK \(bolsa IN \(([^)]+)\)\)/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  )
}

export function extraerCheckBolsa(contenido) {
  const todos = extraerChecksBolsa(contenido)
  if (todos.length === 0) throw new Error('no se encontro el CHECK de "bolsa" en la migracion')
  return todos[0]
}

/** Cada CHECK de `bolsa` que exista en la carpeta de migraciones, con el nombre
 *  del archivo donde vive para que el error diga donde mirar. */
export function checksDeLasMigraciones(archivos, leer) {
  const salida = []
  for (const archivo of archivos) {
    for (const check of extraerChecksBolsa(leer(archivo))) salida.push({ archivo, check })
  }
  return salida
}

/**
 * Los tipos de bolsa que declara el esquema del SQLite del Durable Object.
 *
 * Es la TERCERA copia de la misma lista, y la mas peligrosa de las tres: es la que
 * gobierna la tabla donde nace el asiento. Las otras dos son TypeScript (que el
 * compilador cuida) y el CHECK de D1 (que solo recibe copias).
 *
 * Esta frontera se agrego cuando el esquema del DO salio de las pruebas y entro a
 * `src/`. Sin esto, agregar un tipo de bolsa en dos lados y olvidarlo en el tercero
 * no lo agarraba nadie hasta que un INSERT fallara con la plata adentro.
 */
export function extraerTiposDelEsquemaDO(contenido) {
  const m = contenido.match(/export const TIPOS_DE_BOLSA = \[([^\]]+)\]/)
  if (m === null) {
    throw new Error('no se encontro "export const TIPOS_DE_BOLSA" en el esquema del DO')
  }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** Pura, para que la mutacion la pueda atacar sin tocar disco ni procesos. */
export function compararEsquemas(tipos, check) {
  const enCheck = new Set(check)
  const enTipos = new Set(tipos)
  const faltantes = tipos.filter((t) => !enCheck.has(t))
  const sobrantes = check.filter((t) => !enTipos.has(t))
  return { ok: faltantes.length === 0 && sobrantes.length === 0, faltantes, sobrantes }
}

/**
 * El orden tambien importa, y solo entre TypeScript y el esquema del DO.
 *
 * En `bolsas.ts` el orden de `TipoBolsa` es documental, pero en `esquema.ts` la
 * lista se interpola dentro de los `CHECK` del DDL. Que las dos listas tengan los
 * mismos elementos EN EL MISMO ORDEN hace que el DDL generado sea reproducible y
 * que un diff del esquema se lea. No es una ley del dominio: es higiene, y se
 * reporta aparte para que no se confunda con un descuadre de contenido.
 */
export function compararOrden(tipos, delDO) {
  return { ok: tipos.join('|') === delDO.join('|'), tipos, delDO }
}

function main() {
  const tipos = extraerTipoBolsa(readFileSync(ARCHIVO_TIPOS, 'utf8'))
  const delDO = extraerTiposDelEsquemaDO(readFileSync(ARCHIVO_ESQUEMA_DO, 'utf8'))

  // Todas las migraciones, no la primera: ver el encabezado de `extraerChecksBolsa`.
  const migraciones = readdirSync(DIR_MIGRACIONES)
    .filter((n) => n.endsWith('.sql'))
    .sort()
  const enSql = checksDeLasMigraciones(migraciones, (n) =>
    readFileSync(join(DIR_MIGRACIONES, n), 'utf8'),
  )

  if (enSql.length === 0) {
    console.error('\n  check-esquema: NINGUNA migracion declara un CHECK de la columna `bolsa`\n')
    console.error('  O se borro la columna, o cambio la forma en que se declara y esta')
    console.error('  herramienta dejo de verla. Las dos terminan igual: un oraculo que dice OK')
    console.error('  sin haber comparado nada.\n')
    process.exit(1)
  }

  for (const { archivo, check } of enSql) {
    const contraD1 = compararEsquemas(tipos, check)
    if (contraD1.ok) continue

    console.error(`\n  check-esquema: TipoBolsa y el CHECK de ${archivo} se desincronizaron\n`)
    if (contraD1.faltantes.length > 0) {
      console.error(`  en TipoBolsa pero no en el CHECK: ${contraD1.faltantes.join(', ')}`)
    }
    if (contraD1.sobrantes.length > 0) {
      console.error(`  en el CHECK pero no en TipoBolsa: ${contraD1.sobrantes.join(', ')}`)
    }
    console.error('\n  El dia que el outbox copie un asiento con la bolsa que falta, el INSERT')
    console.error('  en ledger_copia va a violar el CHECK: el outbox se traba ahi, y ese asiento')
    console.error('  queda invisible para el oraculo en vez de visible.\n')
    process.exit(1)
  }

  const contraDO = compararEsquemas(tipos, delDO)
  if (!contraDO.ok) {
    console.error('\n  check-esquema: TipoBolsa y el esquema del Durable Object se desincronizaron\n')
    if (contraDO.faltantes.length > 0) {
      console.error(`  en TipoBolsa pero no en el esquema del DO: ${contraDO.faltantes.join(', ')}`)
    }
    if (contraDO.sobrantes.length > 0) {
      console.error(`  en el esquema del DO pero no en TipoBolsa: ${contraDO.sobrantes.join(', ')}`)
    }
    console.error('\n  Esta es la peor de las tres fronteras: el esquema del DO gobierna la tabla')
    console.error('  donde NACE el asiento. Un tipo de bolsa que le falte hace que el INSERT')
    console.error('  falle con la plata adentro de la operacion, no en una copia posterior.\n')
    process.exit(1)
  }

  const orden = compararOrden(tipos, delDO)
  if (!orden.ok) {
    console.error('\n  check-esquema: TipoBolsa y el esquema del DO tienen los mismos tipos en')
    console.error('  DISTINTO ORDEN\n')
    console.error(`  TipoBolsa          : ${orden.tipos.join(', ')}`)
    console.error(`  esquema del DO     : ${orden.delDO.join(', ')}`)
    console.error('\n  El contenido coincide, asi que ninguna operacion se rompe. Pero la lista')
    console.error('  del DO se interpola dentro de los CHECK del DDL, y con el orden distinto el')
    console.error('  esquema generado cambia sin que haya cambiado nada.\n')
    process.exit(1)
  }

  console.log(
    `  check-esquema: TipoBolsa, el esquema del DO y los ${enSql.length} CHECK de las migraciones coinciden (${tipos.join(', ')})`,
  )
}

if (invocadoDirecto(import.meta)) main()
