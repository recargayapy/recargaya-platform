#!/usr/bin/env node
/**
 * ¿Este modulo se esta corriendo como programa, o alguien lo importo?
 *
 * Los oraculos del proyecto exportan funciones puras para que sus pruebas las
 * verifiquen sin tocar disco, y ademas corren como programa. Ese doble rol
 * necesita un guard, y el guard tiene dos formas malas de escribirse:
 *
 *   · `process.argv[1].endsWith('check-x.mjs')` — por NOMBRE. Invocado por un
 *     symlink o una copia con otro nombre, el modulo se importa, no verifica
 *     nada y el proceso sale con 0. El peor final posible para un oraculo.
 *     Medido: un symlink lo neutralizaba en silencio.
 *
 *   · `import.meta.main` — correcto, pero existe desde Node 22.20. En un Node
 *     anterior vale `undefined`, que es falsy, y el resultado es el mismo exit 0
 *     sin verificar nada. `package.json` declara el piso en `engines`, pero un
 *     `engines` no impide nada por si solo.
 *
 * Asi que se compara la ruta REAL del archivo que Node arranco contra la ruta
 * real de este modulo. Resuelve el symlink, no depende del nombre, y funciona en
 * cualquier version de Node.
 *
 * Uso:  if (invocadoDirecto(import.meta.url)) main()
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function invocadoDirecto(urlDelModulo) {
  const arrancado = process.argv[1]
  if (arrancado === undefined) return false

  try {
    return realpathSync(arrancado) === realpathSync(fileURLToPath(urlDelModulo))
  } catch {
    // Si alguna de las dos rutas no se puede resolver, la respuesta honesta es
    // que no sabemos — y para un oraculo, "no se" tiene que comportarse como
    // "corre": es mejor verificar de mas que salir con 0 sin haber medido nada.
    return true
  }
}
