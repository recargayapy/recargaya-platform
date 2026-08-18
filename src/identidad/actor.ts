/**
 * Quien llama. La primera puerta del sistema, y por lo tanto la unica que decide
 * de quien es el `actor_id` que va a quedar escrito en la bitacora para siempre.
 *
 * ---------------------------------------------------------------------------
 * QUE SE ELIGIO, Y CONTRA QUE
 *
 * Decidido con el dueño el 18/08/2026, con las tres opciones sobre la mesa:
 *
 *   · token de servicio firmado          ← esta
 *   · sesion propia con cookie firmada
 *   · Cloudflare Access adelante
 *
 * Hoy no hay ni login ni una sola pantalla portada, asi que una sesion de
 * usuario seria alcance de otra entrega metido en esta. Y Access resuelve "quien
 * de la empresa entra", que no es la pregunta: la plataforma abre al publico.
 *
 * Lo que hace que esto no termine en dos mecanismos conviviendo —que es el
 * riesgo que el documento de la fase nombra— es que TODO el sistema pregunta
 * "¿quien sos?" por una sola funcion, `actorDeLaPeticion`, y recibe un `Actor`.
 * El dia que llegue la sesion de verdad, se reemplaza el cuerpo de esa funcion.
 * Los endpoints no se enteran.
 *
 * ---------------------------------------------------------------------------
 * POR QUE LA PLATAFORMA NO ES UNA PERSONA
 *
 * Crear la primera persona no lo puede pedir una persona: no hay ninguna. Se
 * podria haber inventado una capacidad `admin`, y eso mezcla dos cosas distintas
 * —lo que una cuenta de la plataforma puede hacer, y lo que un usuario puede
 * hacer— en la misma tabla, que es el error que `personas`/`capacidades` existe
 * para no cometer.
 *
 * `Actor` es una union: o sos la plataforma, o sos una persona. Hoy las dos
 * llegan firmadas con el mismo secreto, porque hoy el unico que tiene el secreto
 * ES la plataforma. Cuando exista la sesion, los actores `persona` van a nacer de
 * ahi y el token de plataforma va a quedar para lo interno. La union no cambia.
 *
 * ---------------------------------------------------------------------------
 * LO QUE ESTO NO RESUELVE, dicho antes de que alguien lo suponga
 *
 * Es un token al portador. Quien lo capture dentro de su ventana de frescura
 * puede repetir cualquier llamada, con otro cuerpo y otro monto. La ventana lo
 * acota a minutos y no a meses, y la clave de idempotencia hace que repetir la
 * MISMA llamada no mueva plata dos veces — pero no impide una llamada distinta.
 * Cerrarlo de verdad pide firmar el cuerpo o llevar un registro de tokens ya
 * usados, y las dos son trabajo de otra entrega. Queda escrito acá y no en el
 * chat.
 */

import { type Instante, instante } from '../dinero/momento.js'

export type Actor =
  | { readonly tipo: 'plataforma' }
  | { readonly tipo: 'persona'; readonly persona_id: string }

/**
 * Los textos que `actorId()` puede emitir para algo que NO es una persona.
 *
 * Vive acá —y no en `api/rutas.ts`— porque acá es donde se decide como se escribe
 * un actor, y una lista de reservados que no este al lado de lo que reserva es una
 * lista que se olvida. `rutas.ts` la importa para `POST /personas`.
 */
export const RESERVADOS: readonly string[] = ['plataforma']

/** Como se escribe un actor en la bitacora. La plataforma tambien deja rastro. */
export function actorId(actor: Actor): string {
  return actor.tipo === 'plataforma' ? 'plataforma' : actor.persona_id
}

export type MotivoRechazo =
  | 'sin_encabezado'
  | 'forma_invalida'
  | 'version_desconocida'
  | 'cuerpo_ilegible'
  | 'cuerpo_invalido'
  | 'firma_ilegible'
  | 'firma_invalida'
  | 'entorno_ajeno'
  | 'token_vencido'
  | 'token_del_futuro'
  | 'sin_secreto'
  | 'secreto_debil'

/**
 * El rechazo lleva el motivo ADENTRO, y el motivo no sale por la respuesta.
 *
 * Contestarle a quien golpea la puerta si lo que fallo fue la firma o la fecha le
 * regala la mitad del trabajo: con "firma invalida" sabe que la forma del token
 * es correcta y solo le falta el secreto. Afuera va un 401 pelado; el motivo va
 * al log, que es donde lo necesita el que opera.
 */
export class TokenInvalido extends Error {
  constructor(readonly motivo: MotivoRechazo) {
    super(`token rechazado: ${motivo}`)
    this.name = 'TokenInvalido'
  }
}

/** Cuanto vale un token desde que se emite. */
export const VENTANA_MS = 5 * 60 * 1000

/**
 * Cuanto se le perdona a un reloj adelantado.
 *
 * No es cortesia: el que firma el token corre en otra maquina que la que lo
 * verifica, y dos relojes NTP sanos difieren en decenas de milisegundos. Sin
 * margen, un token emitido "ahora" en una maquina medio segundo adelantada se
 * rechaza por venir del futuro, de forma intermitente y sin patron. Un minuto es
 * holgado para un reloj sano y corto para uno que miente.
 */
export const MARGEN_FUTURO_MS = 60 * 1000

const PREFIJO = 'v1'

/**
 * Las tres partes, sin tocar criptografia. Pura, para que la mutacion la ataque
 * sin necesidad de una clave.
 *
 * `firmado` incluye el prefijo de version a proposito: asi la version queda
 * DENTRO de lo que la firma cubre. Si solo se firmara el cuerpo, cualquiera
 * podria cambiar `v1` por `v2` sin invalidar nada, y el dia que exista un v2 con
 * otras reglas eso seria una forma de elegir cual se aplica.
 */
export function partirToken(texto: string): { firmado: string; cuerpo: string; firma: string } {
  const partes = texto.split('.')
  if (partes.length !== 3) throw new TokenInvalido('forma_invalida')

  const [version, cuerpo, firma] = partes as [string, string, string]
  if (version !== PREFIJO) throw new TokenInvalido('version_desconocida')
  if (cuerpo.length === 0 || firma.length === 0) throw new TokenInvalido('forma_invalida')

  return { firmado: `${version}.${cuerpo}`, cuerpo, firma }
}

/**
 * base64url → bytes.
 *
 * `atob` habla base64 clasico, asi que hay que devolver `-` y `_` a `+` y `/` y
 * reponer el relleno. Un token con basura adentro hace tirar a `atob`: se captura
 * y se convierte en un rechazo con motivo, en vez de dejar salir un
 * `InvalidCharacterError` que no dice nada del dominio.
 */
export function desdeBase64Url(texto: string): Uint8Array {
  const base64 = texto.replaceAll('-', '+').replaceAll('_', '/')
  const relleno = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4))
  let binario: string
  try {
    binario = atob(base64 + relleno)
  } catch {
    throw new TokenInvalido('cuerpo_ilegible')
  }
  const bytes = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i)
  return bytes
}

export function haciaBase64Url(bytes: Uint8Array): string {
  let binario = ''
  for (const b of bytes) binario += String.fromCharCode(b)
  return btoa(binario).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export interface CuerpoDelToken {
  readonly actor: Actor
  readonly emitido_en: Instante
  /**
   * A que entorno pertenece este token.
   *
   * LO PIDIO UNA AUDITORIA, y el argumento es el mismo que `wrangler.jsonc` ya
   * escribe para la base, el bucket y la cola: «si los comparten, una prueba en
   * staging mueve plata de verdad». El secreto lo pone una persona a mano con
   * `wrangler secret put`, dos veces, y poner el mismo valor en los dos entornos es
   * el movimiento natural — nada en el repositorio lo desaconsejaba. Con el mismo
   * secreto y sin este campo, un token emitido para probar en staging acredita
   * guaranies en produccion.
   *
   * Va DENTRO de lo firmado, asi que no se puede cambiar sin el secreto.
   */
  readonly entorno: string
}

/**
 * Interpreta el JSON del token. Pura, y estricta a proposito: un campo que no se
 * entiende es un rechazo, no un valor por defecto.
 *
 * `actor: 'persona'` sin `persona_id` es el caso que hay que rechazar con ganas.
 * Un `persona_id` vacio o ausente que cayera en un `?? ''` dejaria filas de
 * bitacora con actor en blanco, que es peor que no tener bitacora: parece que hay
 * registro.
 */
export function interpretarCuerpo(json: unknown): CuerpoDelToken {
  if (typeof json !== 'object' || json === null) throw new TokenInvalido('cuerpo_invalido')
  const o = json as Record<string, unknown>

  let emitido_en: Instante
  try {
    emitido_en = instante(o['emitido_en'])
  } catch {
    throw new TokenInvalido('cuerpo_invalido')
  }

  const entorno = o['entorno']
  if (typeof entorno !== 'string' || entorno.length === 0) throw new TokenInvalido('cuerpo_invalido')

  if (o['actor'] === 'plataforma') return { actor: { tipo: 'plataforma' }, emitido_en, entorno }

  if (o['actor'] === 'persona') {
    const persona_id = o['persona_id']
    if (typeof persona_id !== 'string' || persona_id.length === 0) {
      throw new TokenInvalido('cuerpo_invalido')
    }
    // Los nombres reservados se rechazan TAMBIEN acá, y no solo en `POST /personas`.
    // La segunda vuelta lo midio: `IDS_RESERVADOS` cerraba la puerta de creacion, y
    // este es el unico camino por el que entra un `persona_id` que no paso por ahi.
    // Que hoy no haga daño depende de que ninguna ruta deje a un actor `persona`
    // escribir bitacora — o sea, de un accidente de las autorizaciones, no del
    // guarda. La primera ruta futura que lo permita reabre el agujero.
    if (RESERVADOS.includes(persona_id.toLowerCase())) throw new TokenInvalido('cuerpo_invalido')
    return { actor: { tipo: 'persona', persona_id }, emitido_en, entorno }
  }

  throw new TokenInvalido('cuerpo_invalido')
}

/**
 * ¿El token esta dentro de su ventana? Pura, con los dos instantes por parametro
 * — el momento no se lee del reloj acá, por la misma razon que en el resto del
 * proyecto: un vencimiento que no se puede probar sin esperar cinco minutos no se
 * prueba.
 *
 * LOS DOS BORDES, y son asimetricos a proposito:
 *
 *   · hacia atras se rechaza cuando la edad ALCANZA la ventana (`edad >= ventana`),
 *     o sea que el limite es el primer instante invalido. Un token que vale
 *     exactamente hasta su ultimo milisegundo es un borde que nadie puede observar
 *     y que cada lector interpreta distinto.
 *   · hacia adelante se perdona el margen INCLUSIVE (`-edad > margen`): un token
 *     exactamente `MARGEN_FUTURO_MS` adelantado todavia entra. Es un margen para
 *     relojes sanos, y en un margen conviene ser generoso en el borde.
 *
 * (La version anterior de este parrafo decia «los dos bordes» y declaraba uno.)
 */
export function frescura(
  emitido_en: Instante,
  momento: Instante,
  ventana_ms: number = VENTANA_MS,
  margen_ms: number = MARGEN_FUTURO_MS,
): 'fresco' | 'vencido' | 'del_futuro' {
  const edad = Date.parse(momento) - Date.parse(emitido_en)
  if (edad >= ventana_ms) return 'vencido'
  if (-edad > margen_ms) return 'del_futuro'
  return 'fresco'
}

/** El secreto, como clave HMAC-SHA256. Se importa en cada uso: es barato y evita
 *  guardar material de clave vivo entre peticiones. */
async function clave(secreto: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** Emitir. Vive acá y no en una herramienta suelta para que el que verifica y el
 *  que firma no puedan divergir en la forma del token. */
export async function emitirToken(
  cuerpo: CuerpoDelToken,
  secreto: string,
): Promise<string> {
  const json =
    cuerpo.actor.tipo === 'plataforma'
      ? { actor: 'plataforma', emitido_en: cuerpo.emitido_en, entorno: cuerpo.entorno }
      : {
          actor: 'persona',
          persona_id: cuerpo.actor.persona_id,
          emitido_en: cuerpo.emitido_en,
          entorno: cuerpo.entorno,
        }

  const codificado = haciaBase64Url(new TextEncoder().encode(JSON.stringify(json)))
  const firmado = `${PREFIJO}.${codificado}`
  const firma = await crypto.subtle.sign('HMAC', await clave(secreto), new TextEncoder().encode(firmado))
  return `${firmado}.${haciaBase64Url(new Uint8Array(firma))}`
}

/**
 * Verificar, entero. El unico camino por el que un `Actor` entra al sistema.
 *
 * EL ORDEN, dicho con precision porque la version anterior de este parrafo decia
 * «la firma se comprueba ANTES que todo lo demas» y era falso: la forma y la
 * version se comprueban primero, y no dependen del secreto — un token con tres
 * partes mal puestas se rechaza sin pagar un HMAC.
 *
 * Lo que si es cierto, y es lo que importa: DESPUES de eso, la firma va antes que
 * la fecha y antes que el entorno. Al reves, un token con la fecha rota pero sin
 * firma valida se distinguiria de uno con la fecha bien, y eso le regala trabajo al
 * que prueba tokens. Nada que no venga del que tiene el secreto llega a que se le
 * mire la fecha.
 *
 * (Lo que ese orden ya NO compra es una diferencia observable desde afuera: la
 * respuesta es un 401 pelado en todos los casos, y el motivo va solo al log. Lo que
 * queda es el canal de tiempo.)
 *
 * Y SE VERIFICA, NO SE VUELVE A FIRMAR PARA COMPARAR. Comparar dos firmas con
 * `===` sale en el primer byte que difiere, y ese tiempo es medible: con
 * suficientes intentos se reconstruye la firma correcta byte a byte sin conocer el
 * secreto. `crypto.subtle.verify` compara en tiempo constante. Es la clase de
 * defecto que ninguna prueba de este arnes podria encontrar —las dos versiones dan
 * el mismo veredicto— y por eso va escrito acá, arriba del codigo que lo hace.
 */
export async function verificarToken(
  token: string,
  secreto: string,
  entorno: string,
  momento: Instante,
  ventana_ms: number = VENTANA_MS,
): Promise<Actor> {
  const { firmado, cuerpo, firma } = partirToken(token)

  // La firma se decodifica con su propio motivo. Con el de `desdeBase64Url` a secas,
  // una FIRMA ilegible se logueaba como `cuerpo_ilegible` y el que investigaba salia
  // a mirar el cuerpo del token. Lo midio la segunda vuelta.
  let firmaCruda: Uint8Array
  try {
    firmaCruda = desdeBase64Url(firma)
  } catch {
    throw new TokenInvalido('firma_ilegible')
  }

  const valida = await crypto.subtle.verify(
    'HMAC',
    await clave(secreto),
    firmaCruda,
    new TextEncoder().encode(firmado),
  )
  if (!valida) throw new TokenInvalido('firma_invalida')

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(desdeBase64Url(cuerpo)))
  } catch {
    throw new TokenInvalido('cuerpo_ilegible')
  }

  const interpretado = interpretarCuerpo(json)

  // Antes que la frescura: un token de otro entorno esta mal aunque sea de recien.
  if (interpretado.entorno !== entorno) throw new TokenInvalido('entorno_ajeno')

  const estado = frescura(interpretado.emitido_en, momento, ventana_ms)
  if (estado === 'vencido') throw new TokenInvalido('token_vencido')
  if (estado === 'del_futuro') throw new TokenInvalido('token_del_futuro')

  return interpretado.actor
}

/**
 * El secreto, con su ausencia tratada como lo que es.
 *
 * `SECRETO_SERVICIO` es un secreto de Cloudflare (`wrangler secret put`), asi que
 * NO aparece en `wrangler.jsonc` y por lo tanto no aparece en el `Env` que genera
 * wrangler. En `Entorno` esta declarado OPCIONAL, y eso no es para que compile:
 * es la verdad. Un despliegue al que nadie le puso el secreto existe, y lo que
 * este proyecto no puede permitirse es que en ese despliegue la puerta quede
 * abierta.
 *
 * Falla cerrada, ruidosa y con su propio motivo, para que el operador vea "sin
 * secreto" en el log y no se pregunte por que nadie puede entrar.
 */
export const LARGO_MINIMO_DEL_SECRETO = 32

export function secretoDelServicio(entorno: { readonly SECRETO_SERVICIO?: string }): string {
  const s = entorno.SECRETO_SERVICIO
  // El largo minimo lo pidio una auditoria, con la medicion al lado: con un secreto
  // de tres letras, recuperarlo por fuerza bruta desde un token capturado corre a
  // ~14.000 candidatos por segundo en UN hilo de Node — el espacio entero en poco
  // mas de un segundo. Un secreto debil no es «menos seguro»: es la puerta abierta
  // con un cartel que dice cerrada, y la funcion que existe para no dejarla abierta
  // no puede ser la que la deja.
  if (typeof s !== 'string' || s.length === 0) throw new TokenInvalido('sin_secreto')
  // Motivo distinto del anterior a proposito: los dos cierran la puerta igual, pero
  // le dicen al operador cosas distintas. Con un solo motivo, el que puso un secreto
  // de 24 caracteres leia «no esta configurado» y salia a buscar el `wrangler secret
  // put` que ya habia hecho. Lo midio la segunda vuelta de auditoria.
  if (s.length < LARGO_MINIMO_DEL_SECRETO) throw new TokenInvalido('secreto_debil')
  return s
}

/**
 * De la peticion HTTP al actor. La funcion que el resto del sistema llama.
 *
 * Es la unica que sabe que hoy la identidad viaja en un encabezado
 * `Authorization: Bearer`. Cuando llegue la sesion, cambia acá adentro.
 */
export async function actorDeLaPeticion(
  peticion: Request,
  entorno: { readonly SECRETO_SERVICIO?: string; readonly ENTORNO: string },
  momento: Instante,
): Promise<Actor> {
  const encabezado = peticion.headers.get('authorization')
  if (encabezado === null) throw new TokenInvalido('sin_encabezado')

  const [esquema, token] = encabezado.split(' ')
  if (esquema?.toLowerCase() !== 'bearer' || token === undefined || token.length === 0) {
    throw new TokenInvalido('sin_encabezado')
  }

  return verificarToken(token, secretoDelServicio(entorno), entorno.ENTORNO, momento)
}
