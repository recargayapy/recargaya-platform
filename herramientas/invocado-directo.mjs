#!/usr/bin/env node
/**
 * ¿Este modulo se esta corriendo como programa, o alguien lo importo?
 *
 * Los oraculos exportan funciones puras para que sus pruebas las verifiquen sin
 * tocar disco, y ademas corren como programa. Ese doble rol necesita un guard, y
 * este archivo lleva tres versiones porque las dos primeras estaban mal:
 *
 *   1. `process.argv[1].endsWith('check-x.mjs')` — por NOMBRE. Invocado por un
 *      symlink o una copia con otro nombre, el modulo se importaba, no verificaba
 *      nada y el proceso salia con 0. El peor final posible para un oraculo.
 *
 *   2. Comparar `realpathSync(argv[1])` contra la ruta real del modulo. Arreglaba
 *      el symlink pero traia dos defectos propios, los dos medidos por una
 *      auditoria:
 *
 *      · El `catch` devolvia `true`. Con un `argv[1]` que no se puede resolver
 *        —`node -e "import(...)" texto-cualquiera`, o un worker thread, donde Node
 *        pone el literal `[worker eval]`— importar el modulo corria `main()`.
 *        `generar-tipos.mjs` importa `check-entorno.mjs`, asi que el oraculo
 *        corria adentro del import del generador y, cuando los tipos no coincidian,
 *        hacia `process.exit(1)` ANTES de generar: el generador quedaba incapaz de
 *        arreglar al oraculo.
 *      · Era mas debil que `import.meta.main` para el caso `node <directorio>`
 *        con un `package.json` que declara `main`: ahi `argv[1]` es el directorio,
 *        no el archivo, y el oraculo volvia a salir con 0 sin medir nada.
 *
 *   3. Esta. `import.meta.main` cuando existe —es autoritativo y lo resuelve Node,
 *      no nosotros— y la comparacion de rutas como respaldo para un Node anterior
 *      a la 22.18. El `catch` devuelve `false`: un modulo importado que no puede
 *      resolver su procedencia no arranca un oraculo por las dudas.
 *
 * Recibe `import.meta` entero y no la url, porque `import.meta.main` es propiedad
 * del modulo que pregunta: leerla aca hablaria de este archivo, que nunca es el
 * de entrada.
 *
 * Uso:  if (invocadoDirecto(import.meta)) main()
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function invocadoDirecto(meta) {
  if (typeof meta.main === 'boolean') return meta.main

  const arrancado = process.argv[1]
  if (arrancado === undefined) return false

  try {
    return realpathSync(arrancado) === realpathSync(fileURLToPath(meta.url))
  } catch {
    return false
  }
}
