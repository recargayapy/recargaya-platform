/**
 * Capacidades de una persona, y la unica pregunta que hay que poder contestar:
 * "¿esta persona puede hacer esto, EN ESTE INSTANTE?".
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO ES UN CAMPO `rol`
 *
 * El encabezado de la migracion 0001 ya lo dice y conviene repetirlo donde vive
 * el codigo: cliente + vendedor + creador + distribuidor conviven sobre la MISMA
 * persona desde el dia uno. Un campo `rol` obliga a elegir uno, y el dia que
 * alguien es las dos cosas la salida es una segunda cuenta — con su propia
 * billetera, su propia plata, y ninguna forma de volver atras.
 *
 * Son CUATRO. Se escribe con este enfasis porque en la conversacion del 18/08 se
 * enumeraron tres dos veces seguidas y lo noto el dueño, no la sesion. El
 * distribuidor no es decorativo: tiene pantalla propia capturada en el contrato
 * visual desde la v4.36.0.
 *
 * ---------------------------------------------------------------------------
 * LEY 4, APLICADA A LA SEGUNDA MAGNITUD QUE ORDENA
 *
 * "Que esta vigente / que se consume en este instante es una funcion pura, con
 * precedencia declarada y probada contra casos superpuestos. Nunca un ORDER BY."
 *
 * La ley se escribio para las bolsas del saldo, y esto es exactamente el mismo
 * problema con otro sustantivo: una persona puede haber sido vendedora entre
 * marzo y julio, no serlo entre julio y septiembre, y volver a serlo despues. La
 * pregunta "¿es vendedora?" no tiene respuesta sin un momento, y la respuesta no
 * puede salir de "la fila mas reciente" — eso es un ORDER BY con otro disfraz, y
 * se rompe en cuanto dos ventanas se superponen.
 *
 * Acá la respuesta es una union de ventanas: vigente si ALGUNA ventana contiene
 * al momento. Es una pregunta que no depende del orden de las filas, y por eso
 * cada rama pregunta «¿alguna?» con `some` y ninguna mira `[0]` ni `at(-1)`.
 * (`capacidadesVigentes` si impone un orden, pero sobre la SALIDA y para que el
 * JSON sea reproducible: no decide nada.)
 *
 * ---------------------------------------------------------------------------
 * POR QUE LAS VENTANAS SE SUPERPONEN DE VERDAD, y no es un caso inventado
 *
 * La tabla `capacidades` de 0001 tenia `PRIMARY KEY (persona_id, capacidad)`: una
 * sola fila por par, o sea una sola ventana. Con esa clave, revocar y volver a
 * otorgar solo puede hacerse pisando la fila anterior — y ahi se pierde para
 * siempre que fulano fue vendedor entre marzo y julio, que es justo lo que hay
 * que poder contestar cuando alguien pregunte por que un reparto de marzo pago
 * comision de vendedor.
 *
 * La migracion 0003 mueve la clave a `(persona_id, capacidad, otorgada_en)`, que
 * es lo que permite varias ventanas. Lo que esa clave NO impide es que existan
 * dos ventanas ABIERTAS a la vez para la misma capacidad, que seria un estado sin
 * sentido: eso lo impide un indice unico parcial, del lado de la base.
 */

import { type Instante, instante, instanteOpcional } from '../dinero/momento.js'

/**
 * Las cuatro. `check-esquema.mjs` compara esta linea contra el CHECK de la
 * columna `capacidad` en las migraciones: agregar `afiliado` acá y olvidarlo en
 * el SQL hace fallar `npm run verificar`, en vez de fallar en runtime con la
 * cuenta ya creada.
 */
export type Capacidad = 'cliente' | 'vendedor' | 'creador' | 'distribuidor'

/**
 * El estado de la cuenta. Es la MISMA frontera que la de arriba, sobre la columna
 * `estado` de `personas`, y por eso el oraculo la vigila igual.
 */
export type EstadoPersona = 'activa' | 'suspendida' | 'cerrada'

/**
 * Las listas en runtime, para validar lo que llega de afuera.
 *
 * No se derivan del tipo —TypeScript no existe en runtime— asi que son una
 * segunda copia, y de ahi que `capacidades.pruebas` compruebe que digan lo mismo
 * que el tipo. La copia es inevitable; que nadie la compare, no.
 */
export const CAPACIDADES = ['cliente', 'vendedor', 'creador', 'distribuidor'] as const
export const ESTADOS_DE_PERSONA = ['activa', 'suspendida', 'cerrada'] as const

export function esCapacidad(valor: unknown): valor is Capacidad {
  return typeof valor === 'string' && (CAPACIDADES as readonly string[]).includes(valor)
}

export function esEstadoDePersona(valor: unknown): valor is EstadoPersona {
  return typeof valor === 'string' && (ESTADOS_DE_PERSONA as readonly string[]).includes(valor)
}

/**
 * Una ventana durante la cual una persona tuvo una capacidad.
 *
 * Los dos instantes llevan el tipo marcado `Instante` y no `string`, y esa es la
 * leccion de `dinero/momento.ts` aplicada acá: la vigencia se decide comparando
 * TEXTO (`desde <= momento`), y dos instantes escritos con anchos distintos
 * comparan al reves de como corren los relojes. Con el tipo marcado, una ventana
 * no se puede construir sin haber pasado por `instante()`.
 */
export interface Otorgamiento {
  readonly capacidad: Capacidad
  /** Desde cuando. Inclusive: en su propio instante ya vale. */
  readonly desde: Instante
  /** Hasta cuando, EXCLUSIVE. `null` = sigue vigente. */
  readonly hasta: Instante | null
}

export interface Persona {
  readonly persona_id: string
  readonly estado: EstadoPersona
  /**
   * La billetera de esta persona. Se guarda, no se deriva — ver el encabezado de
   * la migracion 0003.
   */
  readonly billetera_id: string
  readonly creada_en: Instante
  readonly otorgamientos: readonly Otorgamiento[]
}

export type MotivoNegado =
  | 'persona_suspendida'
  | 'persona_cerrada'
  | 'capacidad_vencida'
  | 'capacidad_futura'
  | 'sin_capacidad'

export type Veredicto =
  | { readonly puede: true }
  | { readonly puede: false; readonly motivo: MotivoNegado }

const SI: Veredicto = { puede: true }
const no = (motivo: MotivoNegado): Veredicto => ({ puede: false, motivo })

/**
 * Construye una ventana desde datos crudos —una fila de la base, un cuerpo JSON—
 * validando los dos instantes y la capacidad.
 *
 * Existe para que la validacion ocurra UNA vez, en la puerta, y no repartida en
 * cada sitio que arma un `Otorgamiento`. Es el mismo patron que `guaranies()`.
 */
export function otorgamiento(fila: {
  capacidad: unknown
  otorgada_en: unknown
  hasta: unknown
}): Otorgamiento {
  if (!esCapacidad(fila.capacidad)) {
    throw new Error(
      `capacidad desconocida: ${String(fila.capacidad)} (las que hay: ${CAPACIDADES.join(', ')})`,
    )
  }
  const desde = instante(fila.otorgada_en)
  const hasta = instanteOpcional(fila.hasta)

  // Una ventana que termina ANTES de empezar no es una ventana. Una de duracion
  // CERO si lo es: otorgar y revocar en el mismo milisegundo es legitimo, y no
  // vale nunca, porque `vigente()` pide `momento < hasta`.
  //
  // La primera version rechazaba tambien la de duracion cero (`<=`), y el CHECK de
  // la migracion decia lo mismo. Una auditoria lo midio: revocar en el mismo
  // milisegundo del otorgamiento salia como un 500 y la capacidad quedaba abierta,
  // que es peor que la ventana vacia que se queria evitar.
  if (hasta !== null && hasta < desde) {
    throw new Error(`ventana invalida para ${fila.capacidad}: hasta ${hasta} es anterior a ${desde}`)
  }

  return { capacidad: fila.capacidad, desde, hasta }
}

/**
 * ¿Esta ventana contiene al momento?
 *
 * Los dos bordes son deliberadamente asimetricos y hay que decirlo entero:
 *
 *   · `desde <= momento`  — inclusive. Otorgar una capacidad "ahora" la deja
 *     valida ahora, que es lo que espera cualquiera que la otorgue.
 *   · `momento < hasta`   — exclusive. En el instante exacto del `hasta`, la
 *     capacidad YA no vale.
 *
 * El borde de arriba es el mismo criterio que usa `dinero/bolsas.ts` para el
 * vencimiento (`vence_en <= momento` ⇒ vencida) y eso no es coincidencia: si los
 * dos modulos del sistema que deciden "vigente o no" usaran bordes distintos,
 * habria un instante en el que una bolsa esta vencida y una capacidad no, y la
 * diferencia solo se notaria en el caso raro que nadie prueba.
 */
export function vigente(o: Otorgamiento, momento: Instante): boolean {
  if (o.desde > momento) return false
  if (o.hasta !== null && o.hasta <= momento) return false
  return true
}

/**
 * LA pregunta. Pura: no lee reloj, no toca base, no muta la entrada.
 *
 * PRECEDENCIA DECLARADA, en este orden y no en otro:
 *
 *   1. El estado de la cuenta manda sobre todo. Una persona suspendida no puede
 *      hacer nada aunque tenga la capacidad vigente — si no, suspender una cuenta
 *      no suspenderia nada.
 *   2. Recien despues se miran las ventanas, y alcanza con que UNA contenga al
 *      momento. Es una union, no un maximo: no depende del orden de las filas.
 *
 * EL MOTIVO DEL "NO" TAMBIEN TIENE PRECEDENCIA, y tambien es independiente del
 * orden, porque cada rama pregunta "¿alguna?" y no "¿la primera?":
 *
 *   · `capacidad_vencida` gana sobre `capacidad_futura` — que la tuvo y la
 *     perdio es mas informativo que que la va a tener.
 *   · `sin_capacidad` es el ultimo: no hay ni una ventana de esa capacidad.
 *
 * Sin esa declaracion, con una ventana vencida y otra futura sobre la misma
 * capacidad el motivo saldria de cual fila vino primero de la base. Eso es un
 * ORDER BY escondido en un mensaje de error, y los mensajes de error son lo que
 * alguien lee a las tres de la mañana.
 */
export function puede(persona: Persona, capacidad: Capacidad, momento: Instante): Veredicto {
  if (persona.estado === 'cerrada') return no('persona_cerrada')
  if (persona.estado === 'suspendida') return no('persona_suspendida')

  const suyas = persona.otorgamientos.filter((o) => o.capacidad === capacidad)
  if (suyas.some((o) => vigente(o, momento))) return SI

  if (suyas.some((o) => o.hasta !== null && o.hasta <= momento)) return no('capacidad_vencida')
  if (suyas.some((o) => o.desde > momento)) return no('capacidad_futura')
  return no('sin_capacidad')
}

/**
 * Todas las capacidades vigentes en un momento, para mostrar.
 *
 * Devuelve en el orden declarado de `CAPACIDADES` y no en el de las filas: es
 * para que la salida de la API sea reproducible, y un cambio en la base no
 * cambie el JSON. Que sea estable es lo unico que se le pide — la decision de
 * quien puede que sigue estando en `puede()`, que es la que gobierna.
 */
export function capacidadesVigentes(persona: Persona, momento: Instante): Capacidad[] {
  return CAPACIDADES.filter((c) => puede(persona, c, momento).puede)
}
