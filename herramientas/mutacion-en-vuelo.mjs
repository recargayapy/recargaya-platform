#!/usr/bin/env node
/**
 * La nota en disco de una mutacion que se esta escribiendo AHORA, y su restauracion.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE, Y POR QUE VIVE APARTE DE `mutar.mjs`
 *
 * `mutar.mjs` rompe el codigo del dinero a proposito, un archivo por vez, y lo
 * restaura en un `finally`. Tiene ademas un manejador de `SIGINT`/`SIGTERM`, que cubre
 * el Ctrl-C.
 *
 * Lo que NADA de eso cubre es `SIGKILL`, que se cae el contenedor, o que se corte la
 * luz: el proceso desaparece sin correr una sola linea y el arbol queda con un
 * invariante ROTO A PROPOSITO adentro del codigo del dinero. Paso tres veces en una
 * sola sesion de la entrega 1.3, y dos de esas dejaron mutaciones vivas que se
 * descubrieron por casualidad. Lo peligroso no es la mutacion: es que `npm run
 * verificar` sobre un arbol asi puede pasar en verde —si justo esa mutacion no la
 * cubre nadie— y despues se entrega.
 *
 * Vive en su propio archivo porque lo usan DOS programas: `mutar.mjs`, que anota antes
 * de tocar cada archivo, y `restaurar-mutacion.mjs`, que es lo PRIMERO que corre
 * `npm run verificar`. Importarlo de `mutar.mjs` no se puede —ese archivo corre su
 * cuerpo al importarse— y copiarlo seria dos versiones de la unica funcion que puede
 * pisar el codigo de produccion.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** La raiz sale de la ubicacion de este archivo y no del cwd. Mismo criterio que los
 *  oraculos: un veredicto que depende de donde estabas parado es el defecto n.º 6 de
 *  la Fase 0 con otro disfraz. */
const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/** En `.gitignore`, por la misma razon que el temporal de `check-entorno.mjs`: es
 *  estado de una corrida, no del proyecto. */
export const NOTA_EN_VUELO = join(RAIZ, 'herramientas', '.mutacion-en-vuelo.json')

/**
 * Anota que se va a mutar `archivo`: con que contenido volver, y que se escribio.
 *
 * SE GUARDA TAMBIEN LO MUTADO, y no es un detalle. La primera version guardaba solo el
 * original y restauraba SIEMPRE, con este argumento escrito: «el contenido guardado es
 * el original exacto, y dejarlo mutado un minuto mas es peor que cualquier sorpresa».
 * La segunda vuelta de auditoria de la 1.3 midio la sorpresa: con una nota vieja
 * sobreviviente y trabajo nuevo escrito en ese archivo, la restauracion borraba el
 * trabajo EN SILENCIO, con un mensaje diciendo que todo estaba bien.
 */
export function anotarEnVuelo(archivo, original, mutado) {
  writeFileSync(NOTA_EN_VUELO, JSON.stringify({ archivo, original, mutado }))
}

export function borrarLaNota() {
  if (existsSync(NOTA_EN_VUELO)) rmSync(NOTA_EN_VUELO)
}

/**
 * Restaura lo que una corrida anterior dejo mutado, SI Y SOLO SI el archivo todavia
 * tiene esa mutacion escrita.
 *
 * La comparacion byte por byte contra lo mutado es la diferencia entre un seguro y una
 * escopeta. Hay tres casos y los tres tienen respuesta distinta:
 *
 *   · el archivo esta como lo dejo la mutacion  → se restaura y se avisa
 *   · el archivo ya esta en su original         → la corrida murio entre el restaurar
 *                                                 y el borrar la nota: se limpia la
 *                                                 nota y listo
 *   · el archivo es otra cosa                   → NO SE TOCA. Alguien lo edito, o se
 *                                                 cambio de rama. Se grita y se sale
 *                                                 con 1: escribir encima seria borrar
 *                                                 trabajo con un cartel que dice que
 *                                                 todo salio bien.
 *
 * Devuelve `true` si restauro algo, para que quien la llame sepa que el arbol cambio.
 */
export function restaurarLoQueQuedoDeAntes() {
  if (!existsSync(NOTA_EN_VUELO)) return false

  const nota = JSON.parse(readFileSync(NOTA_EN_VUELO, 'utf8'))
  const destino = join(RAIZ, nota.archivo)
  const enDisco = readFileSync(destino, 'utf8')

  if (enDisco === nota.original) {
    borrarLaNota()
    return false
  }

  if (enDisco !== nota.mutado) {
    console.log('')
    console.log('  HAY UNA NOTA DE MUTACION EN VUELO Y EL ARCHIVO NO TIENE LA MUTACION.')
    console.log(`  ${nota.archivo} cambio por otra razon desde que se anoto.`)
    console.log('  NO SE TOCO NADA: restaurar encima seria borrar tu trabajo.')
    console.log(`  Mirá el archivo, y despues borrá a mano ${NOTA_EN_VUELO}.`)
    console.log('')
    process.exit(1)
  }

  writeFileSync(destino, nota.original)
  borrarLaNota()

  console.log('')
  console.log('  UNA CORRIDA ANTERIOR MURIO CON UNA MUTACION ESCRITA EN EL ARBOL.')
  console.log(`  Se restauro ${nota.archivo} a su contenido original.`)
  console.log('  Corré `git diff` para confirmar que quedo como esperabas.')
  console.log('')
  return true
}
