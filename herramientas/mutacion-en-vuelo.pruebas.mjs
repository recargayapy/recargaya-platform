#!/usr/bin/env node
/**
 * Pruebas del seguro en disco de la mutacion.
 *
 * Es una herramienta que PISA archivos de produccion, asi que sus tres caminos tienen
 * que estar medidos y no razonados. La primera version no los tenia, y la segunda
 * vuelta de auditoria de la entrega 1.3 midio lo que faltaba: con una nota vieja
 * sobreviviente y trabajo nuevo en ese archivo, restauraba encima y borraba el trabajo
 * en silencio.
 *
 * Corren en un directorio temporal con una copia del arbol de `herramientas/`, para
 * que ninguna prueba de una herramienta que escribe archivos escriba en el repo.
 *
 * Uso: node herramientas/mutacion-en-vuelo.pruebas.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/** Un arbol de juguete: `herramientas/` de verdad y un archivo victima. */
function arbol() {
  const dir = mkdtempSync(join(tmpdir(), 'mutacion-en-vuelo-'))
  mkdirSync(join(dir, 'herramientas'))
  for (const archivo of ['mutacion-en-vuelo.mjs', 'restaurar-mutacion.mjs', 'invocado-directo.mjs']) {
    cpSync(join(RAIZ, 'herramientas', archivo), join(dir, 'herramientas', archivo))
  }
  mkdirSync(join(dir, 'src'))
  return dir
}

const ORIGINAL = 'export const X = 1\n'
const MUTADO = 'export const X = 2\n'

function correr(dir) {
  const r = execFileSync(process.execPath, [join(dir, 'herramientas', 'restaurar-mutacion.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  return { salida: r, codigo: 0 }
}

function correrEsperandoFallo(dir) {
  try {
    execFileSync(process.execPath, [join(dir, 'herramientas', 'restaurar-mutacion.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return null
  } catch (e) {
    return { salida: `${e.stdout ?? ''}${e.stderr ?? ''}`, codigo: e.status }
  }
}

function anotar(dir, mutado) {
  writeFileSync(
    join(dir, 'herramientas', '.mutacion-en-vuelo.json'),
    JSON.stringify({ archivo: 'src/victima.ts', original: ORIGINAL, mutado }),
  )
}

const hechos = []

// --- 1 · sin nota, no hace nada y no rompe -----------------------------------
{
  const dir = arbol()
  writeFileSync(join(dir, 'src', 'victima.ts'), ORIGINAL)
  const r = correr(dir)
  assert.match(r.salida, /nada que restaurar/)
  assert.equal(readFileSync(join(dir, 'src', 'victima.ts'), 'utf8'), ORIGINAL)
  rmSync(dir, { recursive: true, force: true })
  hechos.push('sin nota')
}

// --- 2 · con la mutacion escrita, restaura ------------------------------------
{
  const dir = arbol()
  writeFileSync(join(dir, 'src', 'victima.ts'), MUTADO)
  anotar(dir, MUTADO)
  const r = correr(dir)
  assert.match(r.salida, /MURIO CON UNA MUTACION ESCRITA/)
  assert.equal(readFileSync(join(dir, 'src', 'victima.ts'), 'utf8'), ORIGINAL)
  assert.equal(existsSync(join(dir, 'herramientas', '.mutacion-en-vuelo.json')), false)
  rmSync(dir, { recursive: true, force: true })
  hechos.push('restaura')
}

// --- 3 · nota vieja con el archivo ya restaurado: solo limpia ------------------
{
  const dir = arbol()
  writeFileSync(join(dir, 'src', 'victima.ts'), ORIGINAL)
  anotar(dir, MUTADO)
  const r = correr(dir)
  assert.match(r.salida, /nada que restaurar/)
  assert.equal(readFileSync(join(dir, 'src', 'victima.ts'), 'utf8'), ORIGINAL)
  assert.equal(existsSync(join(dir, 'herramientas', '.mutacion-en-vuelo.json')), false)
  rmSync(dir, { recursive: true, force: true })
  hechos.push('nota vieja')
}

// --- 4 · EL QUE IMPORTA: el archivo cambio por otra razon ----------------------
// La segunda vuelta de auditoria midio que la version anterior escribia encima y
// borraba el trabajo, con un mensaje diciendo que todo estaba bien.
{
  const dir = arbol()
  const TRABAJO = 'export const X = 1\nexport const TRABAJO_NUEVO = true\n'
  writeFileSync(join(dir, 'src', 'victima.ts'), TRABAJO)
  anotar(dir, MUTADO)
  const r = correrEsperandoFallo(dir)
  assert.notEqual(r, null, 'tenia que salir con codigo distinto de cero')
  assert.equal(r.codigo, 1)
  assert.match(r.salida, /NO SE TOCO NADA/)
  // LO QUE SE MIDE: el trabajo sigue ahi, y la nota tambien (para que alguien mire).
  assert.equal(readFileSync(join(dir, 'src', 'victima.ts'), 'utf8'), TRABAJO)
  assert.equal(existsSync(join(dir, 'herramientas', '.mutacion-en-vuelo.json')), true)
  rmSync(dir, { recursive: true, force: true })
  hechos.push('no pisa trabajo ajeno')
}

console.log(`  mutacion-en-vuelo.pruebas: OK (${hechos.join(', ')})`)
