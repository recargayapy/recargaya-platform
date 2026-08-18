#!/usr/bin/env node
/**
 * Lee y valida `pruebas-runtime/arnes-del-runtime.json`.
 *
 * Es un modulo propio y no una funcion adentro de uno de los oraculos porque lo
 * necesitan los tres lados. La version anterior tenia la validacion en
 * `check-runtime.mjs` y `check-entorno.mjs` la reimplementaba en tres lineas sin
 * red: con el archivo movido de lugar, uno fallaba con un mensaje y el otro con
 * un stack de `ModuleJob.run`. Eso es «arreglar el caso y no la categoria»
 * adentro del arreglo que centralizo el dato.
 *
 * Que valida, y por que cada cosa:
 *
 *   · `environment` — si falta, miniflare corre con el entorno por defecto y la
 *     fecha efectiva sale de la raiz sin que nadie lo escriba.
 *   · `configPath` — si el arnes apunta a otro wrangler.jsonc, los oraculos
 *     aprueban un archivo que las pruebas no usan. Medido: con un
 *     `configPath: './otro-wrangler.jsonc'` de fecha 2023, el oraculo firmaba
 *     2026-08-01 y las pruebas corrian con 2023.
 *   · `migrationsDir` — de ahi salen las migraciones de D1 que el arnes aplica a
 *     la base local antes de correr las pruebas del publicador. Si apuntara a
 *     otro lado, las pruebas correrian contra un esquema de D1 que no es el que
 *     se despliega: el caso de la tabla de juguete, con otro disfraz. Que sea el
 *     MISMO que declara `wrangler.jsonc` lo comprueba `check-runtime.mjs`; acá
 *     solo se valida que este y sea texto.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const RUTA = join('pruebas-runtime', 'arnes-del-runtime.json')

/** El unico configPath aceptable. Cualquier otro deja a los oraculos mirando un
 *  archivo que el arnes no lee. */
export const CONFIG_ESPERADO = './wrangler.jsonc'

export function leerArnes(texto) {
  let d
  try {
    d = JSON.parse(texto)
  } catch (e) {
    throw new Error(`${RUTA} no es JSON valido: ${e.message}`)
  }

  if (typeof d.environment !== 'string' || d.environment === '') {
    throw new Error(`${RUTA} no declara un \`environment\` que sea texto`)
  }
  if (d.configPath !== CONFIG_ESPERADO) {
    throw new Error(
      `${RUTA} declara configPath "${d.configPath}" y tiene que ser "${CONFIG_ESPERADO}": si el arnes lee otra configuracion, los oraculos aprueban un archivo que las pruebas no usan`,
    )
  }
  if (typeof d.migrationsDir !== 'string' || d.migrationsDir === '') {
    throw new Error(`${RUTA} no declara un \`migrationsDir\` que sea texto`)
  }

  return { environment: d.environment, configPath: d.configPath, migrationsDir: d.migrationsDir }
}

/** Lee el archivo desde la raiz que se le pase. Separado de `leerArnes` para que
 *  la validacion se pruebe sobre texto, sin disco. */
export function leerArnesDesde(raiz) {
  return leerArnes(readFileSync(join(raiz, RUTA), 'utf8'))
}
