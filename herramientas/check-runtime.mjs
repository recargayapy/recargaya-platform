#!/usr/bin/env node
/**
 * Oraculo: la fecha de compatibilidad con la que corren las pruebas del Durable
 * Object tiene que estar ESCRITA, no adivinada por el reloj de la maquina.
 *
 * El agujero, medido en `node_modules/miniflare/dist/src/index.js` (linea 38872):
 *
 *     compatibility_date: config3.compatibility_date ?? getTodaysCompatDate(),
 *
 * Si la configuracion no declara una fecha para el entorno con el que corren las
 * pruebas, miniflare pone **la fecha de hoy del reloj del sistema**. Nadie avisa.
 * El mismo commit pasa hoy y falla el miercoles, o pasa en el CI y falla en la
 * maquina del dueño. Es la misma categoria que el defecto n.º 6 de la Fase 0 —un
 * veredicto que depende de la maquina y no del codigo, aunque ahi el mecanismo
 * eran los fines de linea— y es facil de producir sin querer: alcanza con dejar
 * la fecha comentada un rato mientras se prueba algo.
 *
 * Lo que este archivo NO hace, y por que:
 *
 * No compara la fecha pedida contra la version del paquete `workerd`. Lo hizo, y
 * estaba mal de dos formas. Primero, suponia que la fecha del paquete era el
 * techo de compatibilidad soportado: sondeado contra el binario, `1.20260811.1`
 * soporta hasta 2026-08-18, siete dias mas que su propia fecha de build, porque
 * registra banderas con fecha de activacion futura. Y segundo, no hacia falta:
 * una fecha que el motor no soporta ya falla a los gritos, y esta medido en los
 * dos caminos —`workerd` dice «the newest date supported by this server binary
 * is ...» con el numero exacto, y miniflare rechaza aparte toda fecha posterior a
 * la de hoy con `ERR_FUTURE_COMPATIBILITY_DATE`, sin decir cual si soporta.
 *
 * (El aviso que motivo esa comparacion —«Falling back to ...», miniflare bajando
 * la fecha en silencio— es real, pero del stack VIEJO: aparecio al evaluar
 * quedarse en vitest 2. Con el instalado no existe.)
 *
 * Asi que el oraculo hace cuatro cosas, y ninguna mas:
 *
 *   1. Lee de `pruebas-runtime/entorno-de-pruebas.json` con QUE entorno corren
 *      las pruebas — el mismo archivo que lee el arnes. Si el arnes y el oraculo
 *      miraran entornos distintos, el oraculo no mediria lo que corre.
 *   2. Exige que ese entorno exista en `wrangler.jsonc`. Un entorno que la
 *      configuracion no declara resolveria contra la nada.
 *   3. Resuelve la fecha efectiva como la resuelve wrangler:
 *      `env.<entorno>.compatibility_date` gana sobre la de la raiz.
 *   4. Falla si no hay ninguna, y falla si el arnes la sobreescribe por su cuenta
 *      con un `compatibilityDate` de miniflare — porque ahi la fecha efectiva ya
 *      no es la que este oraculo acaba de aprobar.
 *
 * Uso:  node herramientas/check-runtime.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { invocadoDirecto } from './invocado-directo.mjs'

/** La raiz del repositorio, derivada de la ubicacion de este archivo y no del
 *  directorio desde el que se lo invoca: un oraculo cuyo veredicto depende de
 *  donde estabas parado es la clase de cosa que este archivo existe para
 *  impedir. */
const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/**
 * Convierte JSONC en JSON parseable: saca comentarios de linea y de bloque, y
 * las comas colgantes.
 *
 * Va caracter por caracter porque tiene que saber cuando esta ADENTRO de una
 * cadena. La version anterior de este archivo usaba una expresion regular sobre
 * el texto y descartaba las lineas que arrancaban con `//`, y eso fallaba en
 * tres formas medidas: un comentario al final de una linea de codigo contaba
 * como una segunda fecha, un comentario de bloque con una fecha vieja
 * adentro contaba como fecha valida, y la fecha de un `env.<nombre>` contaba
 * como conflicto cuando en realidad es la que manda.
 */
export function normalizarJsonc(texto) {
  let salida = ''
  let i = 0
  let enCadena = false

  /** Emite un caracter, y si es `}` o `]`, borra la coma colgante que quedo
   *  atras. JSONC las permite; JSON.parse no. */
  const emitir = (c) => {
    if (c === '}' || c === ']') {
      const recortado = salida.replace(/\s+$/, '')
      if (recortado.endsWith(',')) salida = recortado.slice(0, -1)
    }
    salida += c
  }

  while (i < texto.length) {
    const c = texto[i]
    const d = texto[i + 1]

    if (enCadena) {
      if (c === '\\') {
        salida += c + (d ?? '')
        i += 2
        continue
      }
      if (c === '"') enCadena = false
      salida += c
      i += 1
      continue
    }

    if (c === '"') {
      enCadena = true
      salida += c
      i += 1
      continue
    }

    if (c === '/' && d === '/') {
      while (i < texto.length && texto[i] !== '\n') i += 1
      continue
    }

    if (c === '/' && d === '*') {
      i += 2
      while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i += 1
      i += 2
      continue
    }

    emitir(c)
    i += 1
  }

  return salida
}

/** Lee y parsea un wrangler.jsonc. Separado de la resolucion para que la
 *  resolucion se pueda probar sobre objetos, sin disco. */
export function leerConfig(texto) {
  const limpio = normalizarJsonc(texto)
  try {
    return JSON.parse(limpio)
  } catch (e) {
    throw new Error(`wrangler.jsonc no se pudo parsear despues de quitar comentarios: ${e.message}`)
  }
}

/**
 * Con que entorno corren las pruebas del runtime.
 *
 * Sale de un archivo de datos que tambien lee `vitest.runtime.config.ts`. La
 * version anterior lo sacaba del TypeScript del arnes con una expresion regular,
 * y la segunda vuelta de auditoria la rompio de dos formas medidas: un glob como
 * `'src/**'` dentro de comillas simples abria un comentario de bloque que se
 * comia el resto del archivo, y `test.environment` —que es una opcion propia de
 * vitest, con los valores `node` o `jsdom`— contaba como segunda coincidencia. En
 * el peor caso el oraculo imprimia OK sobre un entorno llamado "node".
 *
 * Un archivo de datos hace que los dos lados no puedan divergir, que era todo el
 * objetivo. Parsear TypeScript con texto nunca lo era.
 */
export function entornoDePruebas(textoJson) {
  const d = JSON.parse(textoJson)
  if (typeof d.environment !== 'string' || d.environment === '') {
    throw new Error('entorno-de-pruebas.json no declara un `environment` que sea texto')
  }
  return d.environment
}

/**
 * El arnes no puede sobreescribir la fecha por su cuenta.
 *
 * El pool acepta un bloque `miniflare: { ... }` que pasa opciones crudas, y ese
 * bloque esta declarado como objeto laxo: TypeScript no revisa lo que va adentro.
 * Un `compatibilityDate` ahi gana sobre todo lo que resuelve este oraculo, y
 * quedaria imprimiendo OK sobre una fecha que no es la efectiva. Medido: con
 * `miniflare: { compatibilityDate: '2023-01-01' }` el oraculo decia OK y las
 * pruebas corrian con 2023.
 *
 * No se intenta resolverlo: se prohibe. Detectar y fallar, que es lo que se puede
 * hacer bien sin parsear TypeScript.
 */
export function buscarFechaImpuestaPorElArnes(texto) {
  const m = /compatibilityDate|compatibility_date/.exec(texto)
  return m === null ? null : m[0]
}

/**
 * La fecha efectiva, resuelta como la resuelve wrangler: la del entorno gana
 * sobre la de la raiz. Devuelve tambien de donde salio, para que el mensaje de
 * error sirva para algo.
 *
 * `null` no es un caso raro que se pueda ignorar: es EL caso que este oraculo
 * existe para agarrar, porque ahi entra el reloj del sistema.
 */
export function fechaEfectiva(config, entorno) {
  const delEntorno = config?.env?.[entorno]?.compatibility_date
  if (typeof delEntorno === 'string') return { fecha: delEntorno, origen: `env.${entorno}` }

  const deLaRaiz = config?.compatibility_date
  if (typeof deLaRaiz === 'string') return { fecha: deLaRaiz, origen: 'raiz' }

  return { fecha: null, origen: null }
}

/** Que sea una fecha, y una que exista. `2026-02-30` no existe, y JavaScript la
 *  corre en silencio a 2026-03-02: una fecha corrida dos dias es peor que un
 *  error, porque el oraculo compara contra algo que nadie escribio. */
export function esFechaReal(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false
  const d = new Date(`${fecha}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(fecha)
}

function main() {
  let entorno
  let config
  let resuelta

  try {
    const arnes = readFileSync(join(RAIZ, 'vitest.runtime.config.ts'), 'utf8')
    const impuesta = buscarFechaImpuestaPorElArnes(arnes)
    if (impuesta !== null) {
      throw new Error(
        `vitest.runtime.config.ts fija la fecha por su cuenta ("${impuesta}"): la efectiva dejaria de ser la de wrangler.jsonc`,
      )
    }

    entorno = entornoDePruebas(
      readFileSync(join(RAIZ, 'pruebas-runtime', 'entorno-de-pruebas.json'), 'utf8'),
    )
    config = leerConfig(readFileSync(join(RAIZ, 'wrangler.jsonc'), 'utf8'))

    if (config?.env?.[entorno] === undefined) {
      throw new Error(`wrangler.jsonc no declara el entorno "${entorno}" que el arnes dice usar`)
    }

    resuelta = fechaEfectiva(config, entorno)
  } catch (e) {
    // El mismo formato que los caminos de falla de abajo. Un oraculo que se cae
    // con un stack de Node le hace perder media hora al que lo lee con el CI en
    // rojo, y este archivo es el que mas se va a leer en ese estado.
    console.error('')
    console.error('  check-runtime: NO SE PUDO DETERMINAR LA FECHA DE COMPATIBILIDAD')
    console.error('')
    console.error(`    ${e.message}`)
    console.error('')
    console.error('  Sin una fecha escrita, miniflare usa la de HOY del reloj del sistema y')
    console.error('  las pruebas del Durable Object pasan a depender del dia en que corren.')
    console.error('')
    process.exit(1)
  }

  if (resuelta.fecha === null) {
    console.error('')
    console.error('  check-runtime: NO HAY compatibility_date PARA EL ENTORNO DE PRUEBAS')
    console.error('')
    console.error(`    el arnes corre con el entorno    : ${entorno}`)
    console.error(`    fecha en env.${entorno}            : no hay`)
    console.error('    fecha en la raiz                 : no hay')
    console.error('')
    console.error('  miniflare NO falla por esto. Pone la fecha de hoy del sistema:')
    console.error('')
    console.error('      compatibility_date: config3.compatibility_date ?? getTodaysCompatDate(),')
    console.error('')
    console.error('  Eso hace que el mismo commit pase hoy y falle el miercoles, y que el CI y')
    console.error('  la maquina del dueño no den el mismo veredicto: un oraculo cuyo resultado')
    console.error('  depende de la maquina no es un oraculo.')
    console.error('')
    console.error('  Un comentario NO cuenta como fecha: si la dejaste comentada mientras')
    console.error('  probabas algo, esto es exactamente lo que tenia que pasar.')
    console.error('')
    process.exit(1)
  }

  if (!esFechaReal(resuelta.fecha)) {
    console.error('')
    console.error('  check-runtime: LA compatibility_date NO ES UNA FECHA REAL')
    console.error('')
    console.error(`    ${resuelta.origen} declara : ${resuelta.fecha}`)
    console.error('')
    console.error('  Se espera YYYY-MM-DD y una fecha que exista. Ojo con las que parecen')
    console.error('  validas: JavaScript convierte 2026-02-30 en 2026-03-02 sin avisar.')
    console.error('')
    process.exit(1)
  }

  console.log(
    `  check-runtime: OK — el arnes corre con el entorno ${entorno}, compatibility_date ${resuelta.fecha} (de ${resuelta.origen})`,
  )
}

// El guard vive en `invocado-directo.mjs`, compartido por los tres oraculos: la
// primera version de este arreglo lo cambio solo aca y dejo `check-esquema.mjs`
// con el guard por nombre. Se arregla la categoria, no el caso.
if (invocadoDirecto(import.meta.url)) main()
