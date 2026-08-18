#!/usr/bin/env node
/**
 * Emite un token de servicio para hablarle a la puerta.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE
 *
 * La entrega 1.2 abrio seis rutas que exigen un token firmado, y no dejo con que
 * emitirlo: `emitirToken()` vivia en `src/identidad/actor.ts` y solo lo usaban las
 * pruebas. O sea que el dueño no podia tocar una sola ruta desde afuera — ni con
 * `curl`, ni para comprobar que staging quedo bien. Seis rutas entregadas y
 * ninguna ejercitada fuera del arnes.
 *
 * ---------------------------------------------------------------------------
 * POR QUE SE BUNDLEA EN VEZ DE COPIAR LA FIRMA
 *
 * Lo obvio era escribir acá el HMAC y el base64url: son veinte lineas. Y seria
 * exactamente el defecto que este proyecto persigue desde la Fase 0 — un doble del
 * original que nadie compara. El dia que la forma del token cambie (una version
 * `v2`, un campo nuevo), el emisor y el verificador se separan en silencio y lo que
 * falla es una peticion en staging a las tres de la mañana.
 *
 * Asi que se usa `emitirToken()` de verdad, la MISMA funcion que el Worker. Node no
 * puede importar el TypeScript del proyecto directamente y esto se midio, no se
 * supuso:
 *
 *   · `import('./src/identidad/actor.ts')` a secas → «TypeScript parameter property
 *     is not supported in strip-only mode» (los `readonly x` en los constructores).
 *   · con `--experimental-transform-types` → «Cannot find module momento.js»: el
 *     proyecto escribe los imports con extension `.js` (como pide NodeNext) y Node
 *     no los reescribe a `.ts`.
 *
 * `esbuild` resuelve las dos cosas, y ya estaba en el arbol como dependencia de
 * vite y de wrangler. Se declara en `package.json` a proposito: depender de una
 * dependencia transitiva es depender de algo que nadie prometio.
 *
 * ---------------------------------------------------------------------------
 * USO
 *
 *   SECRETO_SERVICIO="..." npm run token -- --entorno staging
 *   SECRETO_SERVICIO="..." npm run token -- --entorno staging --persona p-42
 *
 * Si no le pasas el secreto por variable de entorno ni por `--secreto`, lo busca en
 * `.dev.vars` (que esta en `.gitignore` desde el primer commit).
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invocadoDirecto } from './invocado-directo.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

/**
 * Lee los argumentos. Pura, para que la mutacion la ataque sin emitir nada.
 *
 * `--persona` sin valor es un error y no «la plataforma»: un token de plataforma
 * emitido por accidente cuando se queria uno de persona puede hacer cosas que el
 * otro no, y el que lo emitio no se entera hasta que ya las hizo.
 */
export function interpretarArgumentos(argv) {
  const opciones = { actor: 'plataforma', persona_id: null, entorno: null, secreto: null }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const valor = argv[i + 1]
    const pideValor = () => {
      if (valor === undefined || valor.startsWith('--')) throw new Error(`${arg} necesita un valor`)
      i += 1
      return valor
    }

    if (arg === '--entorno') opciones.entorno = pideValor()
    else if (arg === '--persona') {
      opciones.actor = 'persona'
      opciones.persona_id = pideValor()
    } else if (arg === '--secreto') opciones.secreto = pideValor()
    else throw new Error(`argumento desconocido: ${arg}`)
  }

  if (opciones.entorno === null) {
    throw new Error('falta --entorno (staging o produccion): el token lleva el entorno adentro de la firma')
  }
  return opciones
}

/**
 * El secreto, de donde este. NUNCA se imprime.
 *
 * El orden es del mas explicito al mas comodo: lo que se pide a mano gana sobre lo
 * que quedo guardado, para que nadie firme con un secreto que no sabia que estaba
 * ahi.
 */
export function buscarSecreto({ delArgumento, delEntorno, contenidoDevVars }) {
  if (typeof delArgumento === 'string' && delArgumento.length > 0) return delArgumento
  if (typeof delEntorno === 'string' && delEntorno.length > 0) return delEntorno

  if (typeof contenidoDevVars === 'string') {
    const m = contenidoDevVars.match(/^\s*SECRETO_SERVICIO\s*=\s*"?([^"\n]+)"?\s*$/m)
    if (m !== null) return m[1]
  }
  return null
}

/**
 * Trae `emitirToken` y `secretoDelServicio` DEL CODIGO DE VERDAD.
 *
 * Se bundlea a un archivo temporal y se lo importa. El temporal se borra siempre:
 * adentro no hay secretos —el secreto entra por parametro, no se compila— pero un
 * archivo que sobrevive a la corrida es un archivo que alguien encuentra despues y
 * no sabe de donde salio.
 */
export async function cargarActor() {
  const { build } = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'emitir-token-'))
  const salida = join(dir, 'actor.mjs')
  try {
    await build({
      entryPoints: [join(RAIZ, 'src', 'identidad', 'actor.ts')],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      outfile: salida,
      logLevel: 'silent',
    })
    return await import(salida)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  let opciones
  try {
    opciones = interpretarArgumentos(process.argv.slice(2))
  } catch (e) {
    console.error(`\n  ${e.message}\n`)
    console.error('  Uso:')
    console.error('    SECRETO_SERVICIO="..." npm run token -- --entorno staging')
    console.error('    SECRETO_SERVICIO="..." npm run token -- --entorno staging --persona p-42\n')
    process.exit(1)
  }

  const rutaDevVars = join(RAIZ, '.dev.vars')
  const secreto = buscarSecreto({
    delArgumento: opciones.secreto,
    delEntorno: process.env['SECRETO_SERVICIO'],
    contenidoDevVars: existsSync(rutaDevVars) ? readFileSync(rutaDevVars, 'utf8') : null,
  })

  if (secreto === null) {
    console.error('\n  No encontre el secreto.\n')
    console.error('  Pasalo por variable de entorno:')
    console.error('    SECRETO_SERVICIO="..." npm run token -- --entorno staging\n')
    console.error('  En PowerShell:')
    console.error('    $env:SECRETO_SERVICIO = "..."; npm run token -- --entorno staging\n')
    console.error('  O dejalo en `.dev.vars` como SECRETO_SERVICIO="..." (esta en .gitignore).\n')
    process.exit(1)
  }

  const actor = await cargarActor()

  // El MISMO piso que la puerta. Si esto no estuviera, la herramienta emitiria
  // tokens con un secreto que el Worker despues rechaza, y el que lo use va a
  // pensar que el problema es el token.
  try {
    actor.secretoDelServicio({ SECRETO_SERVICIO: secreto })
  } catch (e) {
    console.error(`\n  El secreto no sirve: ${e.motivo ?? e.message}`)
    console.error(`  El minimo son ${actor.LARGO_MINIMO_DEL_SECRETO} caracteres.\n`)
    process.exit(1)
  }

  const cuerpo =
    opciones.actor === 'plataforma'
      ? { actor: { tipo: 'plataforma' }, emitido_en: new Date().toISOString(), entorno: opciones.entorno }
      : {
          actor: { tipo: 'persona', persona_id: opciones.persona_id },
          emitido_en: new Date().toISOString(),
          entorno: opciones.entorno,
        }

  const token = await actor.emitirToken(cuerpo, secreto)

  // El token va SOLO por la salida estandar, y todo lo demas por la de error. Asi
  // `TOKEN=$(npm run token --silent -- --entorno staging)` funciona sin recortar
  // nada.
  console.log(token)
  console.error(`\n  Token de ${opciones.actor}${opciones.persona_id ? ` ${opciones.persona_id}` : ''} para ${opciones.entorno}.`)
  console.error(`  Vale ${actor.VENTANA_MS / 60000} minutos. Despues emitis otro.\n`)
}

if (invocadoDirecto(import.meta)) await main()
