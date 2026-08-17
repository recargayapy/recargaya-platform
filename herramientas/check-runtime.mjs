#!/usr/bin/env node
/**
 * Oraculo: el runtime que juzga tiene que ser el runtime que corre.
 *
 * Las pruebas del Durable Object corren sobre workerd, el mismo motor que
 * Cloudflare ejecuta en produccion — pero sobre la version de workerd que
 * quedo instalada en `node_modules`, no sobre la que Cloudflare tiene hoy.
 *
 * Si la `compatibility_date` de `wrangler.jsonc` es POSTERIOR a la fecha de
 * ese workerd, miniflare no falla: baja la fecha en silencio y sigue.
 *
 *     [mf:warn] The latest compatibility date supported by the installed
 *     Cloudflare Workers Runtime is "2025-09-06", but you've requested
 *     "2026-08-01". Falling back to "2025-09-06"...
 *
 * Un aviso en el log no es un oraculo: nadie lee los logs de una corrida que
 * pasa. Y el resultado es el defecto n.º 6 de la Fase 0 otra vez — un veredicto
 * que depende de la maquina y no del codigo. Las pruebas dirian que todo esta
 * bien sobre un motor que no es el que va a atender la plata.
 *
 * Asi que se mide y se falla.
 *
 * Se lee la version del paquete `workerd` y NO la del binario por plataforma
 * (`@cloudflare/workerd-linux-64`, `-darwin-arm64`, `-windows-64`): un oraculo
 * cuyo veredicto cambia segun el sistema operativo es exactamente lo que este
 * archivo existe para impedir. `workerd` los declara a todos como
 * optionalDependencies y su propia version es la misma en las tres.
 *
 * Uso:  node herramientas/check-runtime.mjs
 */

import { readFileSync } from 'node:fs'

/**
 * Saca la `compatibility_date` de un `wrangler.jsonc`.
 *
 * JSONC tiene comentarios, asi que `JSON.parse` no sirve. En vez de escribir un
 * parser, se descartan las lineas que ARRANCAN con `//` y se exige que quede
 * exactamente UNA coincidencia.
 *
 * Lo que esto hace y lo que no: no entiende comentarios de bloque ni comentarios
 * al final de una linea de codigo. No los necesita — si un comentario nombrara
 * `compatibility_date` en otra linea, habria dos coincidencias y la funcion
 * falla en vez de elegir una. Fallar ruidosamente es el comportamiento correcto:
 * el que rompa esta suposicion se entera en el momento, no dentro de seis meses.
 */
export function extraerFechaCompatibilidad(texto) {
  const sinComentarios = texto
    .split('\n')
    .filter((linea) => !linea.trimStart().startsWith('//'))
    .join('\n')

  const encontradas = [
    ...sinComentarios.matchAll(/"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g),
  ].map((m) => m[1])

  if (encontradas.length === 0) {
    throw new Error('no se encontro "compatibility_date" en wrangler.jsonc')
  }
  if (encontradas.length > 1) {
    throw new Error(
      `se encontraron ${encontradas.length} "compatibility_date" y no se sabe cual manda: ${encontradas.join(', ')}`,
    )
  }
  return encontradas[0]
}

/**
 * Traduce la version del paquete `workerd` a la fecha del motor.
 *
 * El formato es `1.YYYYMMDD.N` — el mayor es siempre 1 y el patch es la
 * revision del dia. Lo unico que importa es el bloque del medio.
 *
 * El sufijo de prelanzamiento (`-alpha`, `-beta`) se acepta a proposito: hoy
 * mismo miniflare se publica como `5.20260811.1-alpha`, y rechazar un
 * prelanzamiento seria una falsa alarma sobre la version que wrangler instala.
 * Lo que se rechaza es que la fecha no sea una fecha.
 *
 * El ancla del final (`$` con el sufijo opcional) y la comprobacion de fecha
 * real existen porque sin ellas esta funcion aceptaba cualquier cosa que
 * EMPEZARA bien: `1.20260230.0` daba "2026-02-30", que JavaScript convierte en
 * silencio a 2026-03-02. Una fecha corrida dos dias es peor que un error: el
 * oraculo compara contra una fecha que nadie escribio.
 */
export function fechaDeWorkerd(version) {
  const m = /^\d+\.(\d{4})(\d{2})(\d{2})\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version)
  if (m === null) {
    throw new Error(`la version de workerd no tiene el formato 1.YYYYMMDD.N: ${version}`)
  }

  const fecha = `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(`${fecha}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || !d.toISOString().startsWith(fecha)) {
    throw new Error(`la version de workerd no codifica una fecha real: ${version}`)
  }
  return fecha
}

/**
 * El veredicto. Puro, para poder probarlo sin instalar dos workerd distintos.
 *
 * Una fecha de compatibilidad ANTERIOR a la del motor es correcta y no se
 * reporta: es justamente para lo que existe la fecha de compatibilidad — un
 * motor nuevo respetando el comportamiento viejo que le pedimos. Lo que no
 * puede pasar es lo contrario.
 */
export function compararRuntime(fechaCompatibilidad, fechaWorkerd) {
  const ok = fechaCompatibilidad <= fechaWorkerd
  return { ok, fechaCompatibilidad, fechaWorkerd }
}

function main() {
  const fechaCompatibilidad = extraerFechaCompatibilidad(readFileSync('wrangler.jsonc', 'utf8'))
  const version = JSON.parse(readFileSync('node_modules/workerd/package.json', 'utf8')).version
  const fechaWorkerd = fechaDeWorkerd(version)

  const r = compararRuntime(fechaCompatibilidad, fechaWorkerd)

  if (!r.ok) {
    console.error('')
    console.error('  check-runtime: EL RUNTIME DE PRUEBA NO ES EL RUNTIME DEL DESPLIEGUE')
    console.error('')
    console.error(`    compatibility_date de wrangler.jsonc : ${r.fechaCompatibilidad}`)
    console.error(`    workerd instalado (${version})       : ${r.fechaWorkerd}`)
    console.error('')
    console.error('  miniflare no va a fallar por esto: baja la fecha en silencio y corre')
    console.error('  igual. Las pruebas del Durable Object pasarian sobre un motor que no')
    console.error('  es el que atiende la plata.')
    console.error('')
    console.error('  Se arregla subiendo wrangler (que arrastra miniflare y workerd), no')
    console.error('  bajando la compatibility_date: bajarla cambia el comportamiento del')
    console.error('  Worker desplegado para tapar un problema de las pruebas.')
    console.error('')
    process.exit(1)
  }

  console.log(
    `  check-runtime: OK — compatibility_date ${r.fechaCompatibilidad} <= workerd ${r.fechaWorkerd}`,
  )
}

// Solo corre cuando se lo invoca directo. Importado, expone las funciones puras
// para que `check-runtime.pruebas.mjs` las verifique sin tocar el disco.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-runtime.mjs')) {
  main()
}
