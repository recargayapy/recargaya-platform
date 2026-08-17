#!/usr/bin/env node
/**
 * Como se invocan las herramientas de linea de comandos, sin pasar por `npx`.
 *
 * EL DEFECTO QUE ESTO CIERRA, y es de los que solo aparecen en una maquina:
 *
 * `mutar.mjs` lanzaba sus oraculos con `execFileSync('npx', ['vitest', ...])`.
 * En Linux y macOS anda. En Windows, `npx` es `npx.cmd`, y desde Node 20.12 y
 * 22.x un `.cmd` NO se puede lanzar sin `shell: true` — es la correccion de la
 * CVE-2024-27980. O sea que en Windows la llamada tira antes de correr nada.
 *
 * Con la linea de base que `mutar.mjs` corre al empezar, eso sale como «ESTE
 * ORACULO YA FALLA SIN MUTACIONES» y aborta: ruidoso, que es lo correcto, pero
 * manda a buscar el problema al lugar equivocado. Sin la linea de base era peor:
 * cada oraculo que no arranca cuenta como «mutacion muerta», y la corrida
 * terminaba diciendo «Todas murieron. Las pruebas prueban algo.» en una maquina
 * donde no se ejecuto una sola prueba.
 *
 * Ese es el defecto n.º 6 de la Fase 0 con otro disfraz —el mismo commit fallando
 * en Windows y pasando en el CI— y el proyecto ya lo tenia anotado: «En Windows
 * hay que invocar `npx.cmd`, no `npx`.» La entrega lo piso igual.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO SE ARREGLA CON `shell: true` NI CON `npx.cmd`
 *
 * `shell: true` funciona, pero mete al interprete del sistema en el medio: los
 * argumentos pasan a depender de las reglas de comillas de cmd.exe o de bash, que
 * son distintas entre si. Un argumento con un espacio o una comilla se comporta
 * distinto segun la maquina, que es exactamente lo que se quiere evitar.
 *
 * `npx.cmd` en Windows y `npx` en el resto es una rama por sistema operativo
 * adentro de una herramienta cuyo trabajo es que el veredicto no dependa del
 * sistema operativo.
 *
 * La forma que no tiene ramas: `npx` no hace falta. Los paquetes declaran su
 * punto de entrada en `bin`, y ese punto de entrada es un archivo `.js`/`.mjs`
 * que corre con el mismo Node que ya esta corriendo. Se lanza
 * `process.execPath` con ese archivo y se termino el problema: sin shell, sin
 * `.cmd`, sin PATH, y de paso sin el arranque de `npx`.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/**
 * El punto de entrada de cada herramienta, tal como lo declara su `package.json`
 * en el campo `bin`.
 *
 * Van escritas y no leidas de cada `package.json` a proposito: leerlas seria
 * codigo que hay que probar para evitar escribir tres rutas, y si una cambia, la
 * comprobacion de mas abajo lo dice con el nombre del paquete. Escrito y
 * verificado es mejor que derivado y silencioso.
 */
export const ENTRADAS = {
  vitest: join('node_modules', 'vitest', 'vitest.mjs'),
  tsc: join('node_modules', 'typescript', 'bin', 'tsc'),
  wrangler: join('node_modules', 'wrangler', 'bin', 'wrangler.js'),
}

/**
 * Pura, para que la mutacion pueda atacarla sin tocar disco: dado el mapa de
 * entradas y una funcion que dice si un archivo existe, devuelve las que faltan.
 */
export function entradasFaltantes(entradas, raiz, existe) {
  return Object.entries(entradas)
    .filter(([, ruta]) => !existe(join(raiz, ruta)))
    .map(([nombre]) => nombre)
}

/**
 * El comando para correr una herramienta: siempre `[node, archivo, ...args]`.
 *
 * Nunca `npx`, nunca `.cmd`, nunca `shell`. El mismo arreglo en las tres
 * plataformas, que es la unica forma de que el veredicto no dependa de cual usas.
 */
export function comando(nombre, ...args) {
  const entrada = ENTRADAS[nombre]
  if (entrada === undefined) {
    throw new Error(`no hay entrada declarada para "${nombre}" en binarios.mjs`)
  }
  const ruta = join(RAIZ, entrada)
  if (!existsSync(ruta)) {
    throw new Error(
      `falta ${entrada}. El punto de entrada de "${nombre}" cambio de lugar, o no se corrio \`npm ci\`.`,
    )
  }
  return [process.execPath, ruta, ...args]
}

/** Los oraculos que usan las mutaciones, armados una sola vez. */
export const ORACULO_NUCLEO = comando('vitest', 'run', '--silent')
export const ORACULO_RUNTIME = comando(
  'vitest',
  'run',
  '--config',
  'vitest.runtime.config.ts',
  '--silent',
)
export const ORACULO_TIPOS = comando('tsc', '--noEmit')
