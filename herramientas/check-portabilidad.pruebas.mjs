#!/usr/bin/env node
/**
 * Pruebas propias de check-portabilidad.mjs.
 *
 * Node plano, no vitest, por la misma razon que las otras: es la herramienta que
 * prueba a la herramienta.
 *
 * Uso: node herramientas/check-portabilidad.pruebas.mjs
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buscarComandosLiterales, archivosDeHerramientas } from './check-portabilidad.mjs'
import { ENTRADAS, entradasFaltantes, comando } from './binarios.mjs'
import { invocadoDirecto } from './invocado-directo.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

assert.equal(invocadoDirecto(import.meta), true)

/**
 * Arma un fragmento de codigo de ejemplo SIN escribir la forma prohibida
 * literalmente.
 *
 * No es coqueteria: `check-portabilidad.mjs` lee TODOS los `.mjs` de
 * `herramientas/`, y este archivo es uno. Con los ejemplos escritos tal cual, el
 * oraculo se acusaba a si mismo —siete hallazgos, todos datos de prueba— y el CI
 * quedaba en rojo por tener pruebas.
 *
 * La salida facil habria sido excluir los `*.pruebas.mjs` del barrido. No: esos
 * archivos tambien lanzan procesos, y una excepcion escrita es una excepcion que
 * se pudre. La regla se queda absoluta y el dato se construye.
 */
const ejemplo = (fn, cmd) => `${fn}('${cmd}', args)`

// --- lo que hay que detectar ----------------------------------------------

assert.deepEqual(buscarComandosLiterales(ejemplo('spawnSync', 'npx')), [
  { linea: 1, comando: 'npx' },
])
assert.deepEqual(buscarComandosLiterales(ejemplo('execFileSync', 'npm')), [
  { linea: 1, comando: 'npm' },
])
assert.deepEqual(buscarComandosLiterales(`  const r = ${ejemplo('spawnSync', 'wrangler')}`), [
  { linea: 1, comando: 'wrangler' },
])

// `node` tampoco: es un .exe en Windows, si, pero depende del PATH — y el que
// resuelva el PATH puede no ser el mismo Node que esta corriendo. La regla es
// absoluta a proposito.
assert.deepEqual(buscarComandosLiterales(ejemplo('spawn', 'node')), [
  { linea: 1, comando: 'node' },
])

// El numero de linea tiene que servir para ir al lugar.
assert.deepEqual(buscarComandosLiterales(`uno\ndos\n${ejemplo('spawnSync', 'npx')}`), [
  { linea: 3, comando: 'npx' },
])

// --- lo que NO hay que detectar -------------------------------------------

// La forma correcta.
assert.deepEqual(buscarComandosLiterales('spawnSync(process.execPath, [archivo])'), [])
assert.deepEqual(buscarComandosLiterales('execFileSync(ejecutable, args)'), [])
assert.deepEqual(buscarComandosLiterales('const [cmd, ...args] = comando("wrangler")'), [])

// UN COMENTARIO NO LANZA NADA. Sin esto, el parrafo que explica la regla pondria
// el CI en rojo — que es exactamente como una auditoria volteo la version anterior
// de otra regla de este mismo proyecto: el oraculo acusaba al archivo de hacer lo
// que el comentario decia no hacer.
assert.deepEqual(buscarComandosLiterales(`// antes decia ${ejemplo('spawnSync', 'npx')}`), [])
assert.deepEqual(buscarComandosLiterales(` * usaba ${ejemplo('execFileSync', 'npx')}`), [])
assert.deepEqual(buscarComandosLiterales(`  /* ${ejemplo('spawnSync', 'npm')} */`), [])

// --- los enlaces de directorio --------------------------------------------
// La segunda mitad de la frontera. `symlinkSync` sin `'junction'` anda en Linux y
// devuelve EPERM en Windows sin permiso de administrador.

// Se arma en dos pedazos por lo mismo que `ejemplo`: escrito entero, este archivo
// se acusaria a si mismo.
const enlace = (extra) => `symlink${'Sync'}(origen, destino${extra})`

assert.deepEqual(buscarComandosLiterales(enlace('')), [
  { linea: 1, comando: 'symlinkSync sin junction' },
])
assert.deepEqual(buscarComandosLiterales(enlace(", 'junction'")), [])

// Un comentario que la menciona tampoco cuenta.
assert.deepEqual(buscarComandosLiterales(`// antes: ${enlace('')}`), [])

// Los campos `de:` y `a:` de mutar.mjs llevan codigo como dato: una mutacion existe
// justamente para escribir la forma rota. Es la unica excepcion, y es angosta.
assert.deepEqual(buscarComandosLiterales(`    a: "${ejemplo('spawnSync', 'npx')}",`), [])
assert.deepEqual(buscarComandosLiterales(`    de: "${enlace('')}",`), [])

// Pero sigue siendo angosta: `de` o `a` como parte de otra cosa NO cuentan.
assert.deepEqual(buscarComandosLiterales(`  const de = ${ejemplo('spawnSync', 'npx')}`), [
  { linea: 1, comando: 'npx' },
])

// --- los oraculos declarados como arreglo ---------------------------------
// No son una llamada, pero terminan en un `execFileSync` igual.

// En pedazos, por lo mismo que los otros dos: escrito entero, este archivo se
// acusaria a si mismo.
const oraculo = (cmd) => `    ${'oraculo'}: ['${cmd}', 'algo'],`

assert.deepEqual(buscarComandosLiterales(oraculo('npx')), [
  { linea: 1, comando: "oraculo: 'npx'" },
])
assert.deepEqual(buscarComandosLiterales(oraculo('node')), [
  { linea: 1, comando: "oraculo: 'node'" },
])

// La forma correcta: una constante de `binarios.mjs`, o el helper.
assert.deepEqual(buscarComandosLiterales('    oraculo: ORACULO_RUNTIME,'), [])
assert.deepEqual(buscarComandosLiterales("    oraculo: conNode('herramientas/x.pruebas.mjs'),"), [])

// --- el arbol de verdad ----------------------------------------------------
// Las de arriba prueban la funcion sobre texto inventado. Esta prueba que sirve
// para lo que tiene que mirar: si `archivosDeHerramientas` devolviera una lista
// vacia, el oraculo saldria OK sin haber leido nada.

const archivos = archivosDeHerramientas([
  'check-esquema.mjs',
  'binarios.mjs',
  'LEEME.txt',
  'visual',
])
assert.deepEqual(archivos, ['binarios.mjs', 'check-esquema.mjs'])

// --- binarios.mjs ----------------------------------------------------------
// Las rutas de los puntos de entrada estan escritas a mano. Si un paquete mueve
// la suya en una subida de version, esto lo dice con el nombre del paquete en vez
// de fallar con un ENOENT adentro de una corrida de mutacion.

assert.deepEqual(entradasFaltantes(ENTRADAS, RAIZ, existsSync), [])

// Y la comprobacion es de verdad: con una entrada inventada, la reporta.
assert.deepEqual(
  entradasFaltantes({ ...ENTRADAS, fantasma: join('node_modules', 'no-existe') }, RAIZ, existsSync),
  ['fantasma'],
)

// El comando siempre arranca con el MISMO Node que esta corriendo. Nunca un
// nombre, nunca un `.cmd`, nunca `shell`.
const c = comando('vitest', 'run')
assert.equal(c[0], process.execPath)
assert.equal(c[1]?.endsWith(join('vitest', 'vitest.mjs')), true)
assert.equal(c[2], 'run')

assert.throws(() => comando('inventado'), /no hay entrada declarada/)

console.log('  check-portabilidad.pruebas: OK')
