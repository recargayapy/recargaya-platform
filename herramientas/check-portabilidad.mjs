#!/usr/bin/env node
/**
 * Oraculo: ninguna herramienta puede lanzar un comando por nombre.
 *
 * La frontera que cubre es la que ya nos mordio: **nuestras herramientas contra el
 * sistema operativo**. En Windows `npx` es `npx.cmd`, y desde Node 20.12 / 22.x un
 * `.cmd` no se puede lanzar sin `shell: true`. Una herramienta que hace
 * `execFileSync('npx', ...)` anda en Linux, anda en el CI, y muere en la maquina
 * del dueño. Es el defecto n.º 6 de la Fase 0 con otro disfraz, y el proyecto ya lo
 * tenia anotado —«En Windows hay que invocar `npx.cmd`, no `npx`»— y la entrega lo
 * piso igual.
 *
 * Los dos or_aculos que ya existen para fronteras parecidas —`check-esquema.mjs`
 * entre TypeScript y el SQL, `check-entorno.mjs` entre TypeScript y los bindings—
 * siguen este mismo patron: una herramienta de Node plano, con funciones puras
 * exportadas, sus pruebas propias, y su mutacion.
 *
 * QUE EXIGE, exactamente, dos cosas:
 *
 *   · Que el primer argumento de `spawnSync`/`execFileSync` sea `process.execPath`
 *     (el mismo Node que ya corre) o algo que salga de `binarios.mjs`. Un nombre de
 *     comando pelado —`'npx'`, `'npm'`, `'node'`, `'wrangler'`— depende del PATH y
 *     de la extension que use cada sistema.
 *   · Que todo `symlinkSync` lleve `'junction'`. Un symlink de directorio necesita
 *     permiso de administrador en Windows y devuelve EPERM sin el; una junction
 *     hace lo mismo sin pedir nada, y en Linux el argumento se ignora.
 *
 * La segunda se agrego DESPUES de la primera, y por el mismo motivo: la version
 * original de este oraculo miraba como se lanzan procesos y no como se crean
 * enlaces. Cubria una parte de la frontera y no la otra — y el defecto que quedaba
 * estaba en el archivo de al lado.
 *
 * QUE NO REVISA, y se dice: los scripts de `package.json`. Ahi `npm` pone
 * `node_modules/.bin` en el PATH y crea los `.cmd` de Windows, asi que
 * `"probar": "vitest run"` es correcto y portable. El problema es solo cuando un
 * proceso de Node lanza otro proceso.
 *
 * Uso:  node herramientas/check-portabilidad.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invocadoDirecto } from './invocado-directo.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))
const CARPETA = 'herramientas'

/** Lo unico que se acepta como primer argumento de un lanzamiento de proceso. */
const PERMITIDOS = ['process.execPath', 'ejecutable', 'cmd', '...comando', 'oraculo']

/**
 * Busca lanzamientos de proceso cuyo comando sea un literal.
 *
 * Pura sobre el texto, para que la mutacion la ataque sin disco. Devuelve la lista
 * de comandos encontrados, con el numero de linea, para que el mensaje sirva.
 */
export function buscarComandosLiterales(texto) {
  const hallazgos = []
  const lineas = texto.split('\n')

  lineas.forEach((linea, i) => {
    // Una linea de comentario no lanza nada. Sin esto, el propio parrafo que
    // explica la regla pondria el CI en rojo — que es como una auditoria volteo la
    // version anterior de otra regla de este mismo proyecto.
    if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return

    // Y los campos `de:` / `a:` de `mutar.mjs` son CODIGO COMO DATO: una mutacion
    // existe para escribir la forma rota y comprobar que algo se da cuenta. Sin
    // esta linea, agregar la mutacion que cuida esta misma regla ponia el oraculo
    // en rojo.
    //
    // Es la unica excepcion, y es angosta a proposito: dos nombres de campo, con
    // su prueba. No es «los archivos de prueba no se revisan» —eso si se pudre—,
    // es «un fragmento declarado como dato de mutacion no es una llamada».
    if (/^\s*(de|a):\s/.test(linea)) return

    const m = /\b(?:spawnSync|spawn|execFileSync|execFile)\s*\(\s*'([^']+)'/.exec(linea)
    if (m !== null) hallazgos.push({ linea: i + 1, comando: m[1] })

    // Y los enlaces de directorio. Un `symlinkSync` sin el tercer argumento crea
    // un symlink, y en Windows eso necesita permiso de administrador o el Modo de
    // desarrollador: el sistema devuelve EPERM. Una junction hace lo mismo sin
    // pedir nada, y en Linux el argumento se ignora.
    //
    // Esta rama se agrego despues del `npx`, y por el mismo motivo: la primera
    // version de este oraculo miraba como se LANZAN procesos y no como se CREAN
    // enlaces. Cubria una parte de la frontera y no la otra, y el defecto que
    // quedaba estaba en el archivo de al lado.
    const e = /\bsymlinkSync\s*\(/.exec(linea)
    if (e !== null && !/'junction'/.test(linea)) {
      hallazgos.push({ linea: i + 1, comando: 'symlinkSync sin junction' })
    }

    // Y los oraculos que `mutar.mjs` declara como arreglo. No son una llamada
    // —los ejecuta el bucle, mas abajo— asi que las dos reglas de arriba no los
    // ven, y sin embargo terminan en un `execFileSync` igual.
    //
    // Esta rama se agrego cuando el propio arnes de mutacion mostro, en su linea
    // de base, dos oraculos con `npx` que habian sobrevivido a un rebase: el
    // tramo que los escribio es anterior al arreglo de portabilidad. La regla
    // cubria las llamadas y no las declaraciones — media frontera otra vez.
    const o = /\boraculo\s*:\s*\[\s*'([^']+)'/.exec(linea)
    if (o !== null) hallazgos.push({ linea: i + 1, comando: `oraculo: '${o[1]}'` })
  })

  return hallazgos
}

/** Los archivos de herramientas, en orden estable para que el reporte no baile. */
export function archivosDeHerramientas(nombres) {
  return nombres.filter((n) => n.endsWith('.mjs')).sort()
}

function main() {
  const carpeta = join(RAIZ, CARPETA)
  const archivos = archivosDeHerramientas(readdirSync(carpeta))

  const malos = []
  for (const archivo of archivos) {
    for (const h of buscarComandosLiterales(readFileSync(join(carpeta, archivo), 'utf8'))) {
      malos.push({ archivo, ...h })
    }
  }

  if (malos.length > 0) {
    console.error('')
    console.error('  check-portabilidad: UNA HERRAMIENTA LANZA UN COMANDO POR NOMBRE')
    console.error('')
    for (const m of malos) {
      console.error(`    ${CARPETA}/${m.archivo}:${m.linea}  →  '${m.comando}'`)
    }
    console.error('')
    console.error('  Un nombre pelado depende del PATH y de la extension de cada sistema. En')
    console.error('  Windows `npx` es `npx.cmd`, y desde Node 20.12 un `.cmd` no se puede')
    console.error('  lanzar sin `shell: true`: la herramienta anda en Linux, anda en el CI, y')
    console.error('  muere en la maquina del dueño.')
    console.error('')
    console.error('  Se arregla con `comando()` de `herramientas/binarios.mjs`, que devuelve')
    console.error('  siempre [node, archivo, ...args]. Sin shell, sin .cmd, sin PATH.')
    console.error('')
    process.exit(1)
  }

  console.log(
    `  check-portabilidad: OK — ${archivos.length} herramientas, ninguna lanza un comando por nombre`,
  )
}

if (invocadoDirecto(import.meta)) main()

// Nota para el que lea la lista de permitidos y no la encuentre usada: `PERMITIDOS`
// documenta que formas SI son aceptables, y el chequeo funciona al reves —busca
// literales entre comillas, que son justamente las que no lo son—. Se deja escrita
// porque es lo primero que alguien va a querer saber al ver fallar esto.
void PERMITIDOS
