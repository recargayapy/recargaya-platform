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

import { readFileSync } from 'node:fs'

const ARCHIVO_TIPOS = 'src/dinero/bolsas.ts'
const ARCHIVO_MIGRACION = 'migraciones/core/0001_cimientos.sql'

export function extraerTipoBolsa(contenido) {
  const m = contenido.match(/export type TipoBolsa = ([^\n]+)/)
  if (m === null) throw new Error('no se encontro "export type TipoBolsa" en el archivo')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

export function extraerCheckBolsa(contenido) {
  const m = contenido.match(/bolsa\s+TEXT NOT NULL CHECK \(bolsa IN \(([^)]+)\)\)/)
  if (m === null) throw new Error('no se encontro el CHECK de "bolsa" en la migracion')
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

function main() {
  const tipos = extraerTipoBolsa(readFileSync(ARCHIVO_TIPOS, 'utf8'))
  const check = extraerCheckBolsa(readFileSync(ARCHIVO_MIGRACION, 'utf8'))
  const r = compararEsquemas(tipos, check)

  if (!r.ok) {
    console.error('\n  check-esquema: TipoBolsa y el CHECK de ledger_copia se desincronizaron\n')
    if (r.faltantes.length > 0) {
      console.error(`  en TipoBolsa pero no en el CHECK: ${r.faltantes.join(', ')}`)
    }
    if (r.sobrantes.length > 0) {
      console.error(`  en el CHECK pero no en TipoBolsa: ${r.sobrantes.join(', ')}`)
    }
    console.error('\n  El dia que el outbox copie un asiento con la bolsa que falta, el INSERT')
    console.error('  en ledger_copia va a violar el CHECK: el outbox se traba ahi, y ese asiento')
    console.error('  queda invisible para el oraculo en vez de visible.\n')
    process.exit(1)
  }

  console.log(`  check-esquema: TipoBolsa y el CHECK de ledger_copia coinciden (${tipos.join(', ')})`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('check-esquema.mjs')) {
  main()
}
