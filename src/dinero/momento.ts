/**
 * El instante, con una sola forma escrita.
 *
 * ---------------------------------------------------------------------------
 * EL DEFECTO QUE ESTO CIERRA, y lo encontro una auditoria adversarial
 *
 * El vencimiento decide de quien es un guarani comparando TEXTO:
 *
 *     bolsa.vence_en <= momento          (dinero/bolsas.ts)
 *     r.vence_en <= momento              (billetera/repositorio.ts)
 *
 * Y la alarma decide cuando despertar convirtiendo a NUMERO:
 *
 *     Date.parse(m.proximoVencimiento)   (billetera/alarma.ts)
 *
 * Las dos formas coinciden mientras todos los instantes esten escritos igual. En
 * cuanto uno llega con otro huso, dejan de coincidir. Medido, con America/Asuncion
 * que es el huso del proyecto:
 *
 *     A = '2026-08-18T23:00:00.000-03:00'   (o sea 2026-08-19T02:00:00Z)
 *     B = '2026-08-19T01:00:00.000Z'
 *
 *     A <= B  como texto : true    ('2026-08-18…' viene antes que '2026-08-19…')
 *     A <= B  como reloj : false   (02:00Z es DESPUES de 01:00Z)
 *
 * O sea que una bolsa se considera vigente cuando ya vencio, o vencida cuando no,
 * y la alarma se programa para un instante distinto del que usa el filtro que la
 * justifica. Nada falla: la plata simplemente se cuenta mal.
 *
 * `CLAUDE.md` ya decia «Almacenamiento: UTC, ISO-8601». Era una convencion sin
 * oraculo, en la unica puerta al dinero — que es exactamente donde el proyecto
 * puso `STRICT` y `CHECK` para todo lo demas. Esto es el `guaranies()` de los
 * instantes: la misma decision, aplicada a la otra magnitud que ordena.
 *
 * ---------------------------------------------------------------------------
 * POR QUE SE RECHAZA EN VEZ DE NORMALIZAR
 *
 * Normalizar —convertir `-03:00` a `Z`— haria que el sistema aceptara dos
 * escrituras del mismo instante y guardara una. Suena amable y es peor: el
 * llamador que mandaba el huso equivocado nunca se entera, y el dia que un
 * segundo llamador compare contra lo que el escribio, no van a coincidir. Se
 * rechaza, con un mensaje que dice como se escribe.
 */

/** Un instante en UTC, ISO-8601 con milisegundos. Marca de tipo: no se puede
 *  fabricar sin pasar por `instante()`. */
export type Instante = string & { readonly __marca: 'Instante' }

export class InstanteInvalido extends Error {
  constructor(
    readonly valor: unknown,
    motivo: string,
  ) {
    super(`instante invalido (${String(valor)}): ${motivo}`)
    this.name = 'InstanteInvalido'
  }
}

/**
 * La UNICA forma aceptada: `YYYY-MM-DDTHH:MM:SS.mmmZ`. Ancho fijo, milisegundos
 * OBLIGATORIOS, `Z` obligatoria. Es exactamente lo que produce
 * `new Date().toISOString()`.
 *
 * POR QUE LOS MILISEGUNDOS NO SON OPCIONALES, y esto lo corrigio la segunda vuelta
 * de auditoria sobre esta misma funcion:
 *
 * La primera version los aceptaba opcionales, y justificaba la decision diciendo
 * que «las dos formas ordenan igual entre si, porque el punto viene despues de los
 * segundos y antes de la Z». El razonamiento estaba AL REVES. `'.'` es 0x2E y `'Z'`
 * es 0x5A, asi que dentro del mismo segundo la forma larga ordena ANTES que la
 * corta, y por reloj es al reves:
 *
 *     A = '2026-08-17T12:00:00Z'      B = '2026-08-17T12:00:00.500Z'
 *     A <= B  como texto : false      como reloj : true
 *
 * Medido de punta a punta sobre workerd: con un `vence_en` en la forma corta, en
 * su instante de vencimiento `reservasVencidas` (que compara texto) decia TODAVIA
 * NO mientras `cuandoDespertar` (que compara reloj) decia YA — la alarma giraba en
 * vacio hasta que el reloj cruzaba al segundo siguiente.
 *
 * O sea: era exactamente el defecto que este archivo existe para cerrar, adentro
 * del archivo que lo cierra. Con ancho fijo, orden de texto y orden de reloj son
 * la misma cosa, y eso deja de ser una promesa.
 */
const FORMA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Comprueba que un texto sea un instante UTC ISO-8601 y lo devuelve marcado.
 *
 * Rechaza tres cosas distintas, y las tres por separado porque los mensajes
 * mandan a lugares distintos:
 *
 *   · lo que no es texto
 *   · lo que no tiene la forma (huso, falta la `Z`, sobra precision)
 *   · lo que tiene la forma y no es una fecha que exista — `2026-02-30` pasa la
 *     expresion regular y JavaScript la corre en silencio a `2026-03-02`. Una
 *     fecha corrida dos dias es peor que un error, porque despues todo el
 *     sistema compara contra algo que nadie escribio.
 */
export function instante(valor: unknown): Instante {
  if (typeof valor !== 'string') {
    throw new InstanteInvalido(valor, 'se esperaba texto')
  }
  if (!FORMA.test(valor)) {
    throw new InstanteInvalido(
      valor,
      'se espera UTC ISO-8601 con milisegundos y Z, exactamente como 2026-08-17T12:00:00.000Z (que es lo que devuelve toISOString)',
    )
  }

  const d = new Date(valor)
  const t = d.getTime()
  if (Number.isNaN(t)) throw new InstanteInvalido(valor, 'no es una fecha real')

  // La vuelta completa: si `toISOString()` no reproduce EXACTAMENTE lo que entro,
  // la fecha se corrio. Con una sola forma aceptada, esta comparacion no necesita
  // normalizar nada — que es la otra cosa que gana el ancho fijo.
  if (d.toISOString() !== valor) {
    throw new InstanteInvalido(valor, `no es una fecha real: JavaScript la corre a ${d.toISOString()}`)
  }

  return valor as Instante
}

/** Igual que `instante()`, pero deja pasar `null` y `undefined` como `null`.
 *  Una bolsa sin vencimiento es legitima; una bolsa con un vencimiento mal
 *  escrito no. */
export function instanteOpcional(valor: unknown): Instante | null {
  if (valor === null || valor === undefined) return null
  return instante(valor)
}

/**
 * EL AÑO CALENDARIO EN UNA ZONA HORARIA. La unica salida de este archivo que no
 * es UTC, y esta acá justamente para que sea la unica.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE
 *
 * El numero de pedido es `RY-<año>-<seis digitos>` y lo lee una persona. Un pedido
 * hecho el 31 de diciembre a las 23:30 en Asuncion tiene que decir 2026, y en UTC
 * ese instante ya es `2027-01-01T02:30:00.000Z`.
 *
 * O sea: si el año saliera de `momento.slice(0, 4)` —que es lo primero que uno
 * escribe, y funciona perfecto los 364 dias que no importan— durante tres horas
 * cada 31 de diciembre los pedidos saldrian numerados con el año siguiente. No
 * falla nada: quedan numerados mal, en una columna que despues alguien usa para
 * facturar.
 *
 * El proyecto ya declaro las dos mitades de esta decision —«Almacenamiento: UTC.
 * Presentacion: America/Asuncion»— y el numero de pedido es PRESENTACION que se
 * guarda. Es el unico caso asi que hay hoy, y por eso la conversion vive en una
 * funcion con nombre en vez de repartida.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `Intl` Y NO RESTARLE TRES HORAS
 *
 * Paraguay no tiene horario de verano desde 2024 y esta fijo en UTC−03:00. Restar
 * tres horas daria hoy el mismo resultado y seria una bomba de tiempo: el dia que
 * el huso cambie —ya cambio una vez— el offset queda escrito en nuestro codigo y
 * nadie lo va a ir a buscar ahi. `Intl` usa la base de datos de husos del runtime,
 * que es la que se actualiza sola.
 *
 * La zona entra por PARAMETRO y sale de `entorno.ZONA_HORARIA`, que ya existe en
 * `wrangler.jsonc` desde la Fase 0. Una zona invalida hace que `Intl` tire
 * `RangeError`, y eso es lo correcto: un despliegue mal configurado tiene que
 * romper ruidosamente y no numerar pedidos con el año equivocado en silencio.
 *
 * Se devuelve un NUMERO y no el texto de cuatro digitos a proposito: quien lo use
 * para formatear tiene que decidir el ancho, y quien lo use para comparar no tiene
 * que parsear nada.
 */
export function anioEnZona(momento: Instante, zona: string): number {
  // `formatToParts` y no `format`: el formato corto de un año depende del
  // calendario y del locale, y `'en-CA'`/`'en-US'` no prometen lo mismo. La parte
  // `year` si esta definida. `numberingSystem: 'latn'` fuerza digitos arabigos —
  // sin eso, un runtime con otro default puede devolver `'٢٠٢٦'`, que `Number()`
  // convierte igual pero que nadie quiere descubrir en produccion.
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    year: 'numeric',
    numberingSystem: 'latn',
  }).formatToParts(new Date(momento))

  const anio = partes.find((p) => p.type === 'year')?.value
  if (anio === undefined) throw new Error(`no se pudo obtener el año de ${momento} en ${zona}`)

  const n = Number(anio)
  if (!Number.isInteger(n)) throw new Error(`año no entero para ${momento} en ${zona}: ${anio}`)
  return n
}
