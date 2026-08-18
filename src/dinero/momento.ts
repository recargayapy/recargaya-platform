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

/** Un instante en UTC, ISO-8601. Marca de tipo: no se puede fabricar sin pasar
 *  por `instante()`. */
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
 * La UNICA forma aceptada: `YYYY-MM-DDTHH:MM:SS` con milisegundos opcionales y
 * `Z` obligatoria.
 *
 * La `Z` no es cosmetica: es lo que hace que comparar texto y comparar reloj den
 * lo mismo. Los milisegundos son opcionales porque `new Date().toISOString()`
 * siempre los pone y un instante escrito a mano casi nunca — y las dos formas
 * ordenan igual entre si, porque el punto viene despues de los segundos y antes
 * de la `Z`.
 */
const FORMA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

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
      'se espera UTC ISO-8601 con Z, por ejemplo 2026-08-17T12:00:00Z o 2026-08-17T12:00:00.000Z',
    )
  }

  const d = new Date(valor)
  const t = d.getTime()
  if (Number.isNaN(t)) throw new InstanteInvalido(valor, 'no es una fecha real')

  // La vuelta completa: si `toISOString()` no reproduce lo que entro, la fecha se
  // corrio. Se compara con milisegundos de los dos lados para que la forma corta
  // tambien pase.
  const conMilis = valor.includes('.') ? valor : `${valor.slice(0, -1)}.000Z`
  if (d.toISOString() !== conMilis) {
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
