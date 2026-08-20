/**
 * El pedido: sus estados, y las UNICAS transiciones que existen.
 *
 * Puro. No lee reloj, no toca base, no sabe que existe Cloudflare. Es la tercera
 * vez que este proyecto escribe una funcion pura para contestar «¿que vale en este
 * instante?» —las bolsas del saldo, las ventanas de capacidad, y ahora esto— y las
 * tres estan separadas de su persistencia por la misma razon: la regla se prueba
 * sin base y la mutacion la puede atacar cientos de veces por segundo.
 *
 * ---------------------------------------------------------------------------
 * QUE PROBLEMA RESUELVE UNA MAQUINA DE ESTADOS ESCRITA APARTE
 *
 * La tabla `pedidos` existe desde 0001 con un `CHECK (estado IN (...))`. Un CHECK
 * dice QUE VALORES son legales; no dice nada de QUE CAMINOS son legales. Con solo
 * el CHECK, un `UPDATE pedidos SET estado = 'creado' WHERE id = ?` sobre un pedido
 * ya repartido pasa sin una sola queja — y ese pedido vuelve a ser reservable,
 * cancelable, y cobrable por segunda vez.
 *
 * Acá los caminos se declaran, y todo lo que no esta declarado no existe.
 *
 * ---------------------------------------------------------------------------
 * EL ESTADO NO ES UNA ETIQUETA: DICE DONDE ESTA LA PLATA
 *
 * Esta es la parte que hay que leer despacio, porque es la que se puede escribir
 * mal sin que nada falle.
 *
 *   · `creado`     — el pedido existe, la plata NO se toco. Todavia esta en las
 *                    bolsas del comprador, gastable por cualquier otra cosa.
 *   · `reservado`  — la plata esta RETENIDA en la billetera del comprador, en la
 *                    bolsa `retenido`, atada a una reserva con el nombre del
 *                    pedido. Sigue siendo del comprador y ya no la puede gastar.
 *   · `pagado`     — la reserva se consumio. La plata SALIO de la billetera.
 *   · `repartido`  — se repartio entre los que corresponde. Terminal.
 *   · `cancelado`  — terminal, y con la plata YA DEVUELTA: se libera lo que haya
 *                    antes de escribir este estado. Vuelve a sus bolsas de origen
 *                    con su vencimiento y su restriccion originales (ley 11).
 *
 * O sea que cada transicion tiene un efecto sobre el dinero, y ese efecto NO se
 * declara en una tabla al lado. Se DERIVA de que estados retienen plata y cuales
 * no (`efectoSobreLaReserva`). La diferencia importa: una segunda tabla escrita a
 * mano es una tabla que un dia dice `reservado -> cancelado: ninguno`, y esa linea
 * no rompe ninguna prueba de transiciones — deja la plata retenida para siempre en
 * un pedido cancelado, que es plata que el dueño ve como suya y no puede usar.
 * Derivada, esa linea no se puede escribir.
 *
 * ---------------------------------------------------------------------------
 * POR QUE `pagado -> cancelado` NO ESTA
 *
 * Es la ausencia que mas se va a querer agregar, asi que queda escrita.
 *
 * Cancelar un pedido reservado es devolver plata que nunca se movio de la
 * billetera: `liberarReserva()` la pone de vuelta en sus bolsas y no hay nada mas
 * que hacer. Cancelar un pedido PAGADO es otra cosa completamente distinta: la
 * plata ya salio, ya se le acredito a alguien, y «deshacerlo» es un asiento de
 * compensacion contra las billeteras que la recibieron (ley 2: un asiento no se
 * edita, se compensa).
 *
 * Un reembolso NO es una transicion de estado: es plata moviendose al reves, con
 * su propia idempotencia, su propio registro y su propia decision sobre quien lo
 * autoriza. El dia que se escriba, va a agregar un estado —`reembolsado`— y su
 * camino. Poner hoy `pagado -> cancelado` seria dejar que alguien cancele un
 * pedido cobrado y que el sistema conteste 200 sin devolver un guarani.
 */

/**
 * Los cinco. `check-esquema.mjs` compara esta linea contra el CHECK de la columna
 * `estado` de `pedidos`: agregar `reembolsado` acá y olvidarlo en el SQL hace
 * fallar `npm run verificar`, en vez de fallar en runtime con el pedido cobrado.
 *
 * Cuatro venian de 0001. `reservado` lo agrega 0004 y es de esta entrega: sin el,
 * «el pedido existe» y «la plata esta retenida» son el mismo estado, y no hay forma
 * de distinguir un pedido que quedo a medio nacer de uno que reservo bien.
 */
export type EstadoPedido = 'creado' | 'reservado' | 'pagado' | 'repartido' | 'cancelado'

/**
 * La lista en runtime, para validar lo que sale de la base. No se deriva del tipo
 * —TypeScript no existe en runtime— asi que es una segunda copia, y por eso
 * `pedido.test.ts` compara las dos. La copia es inevitable; que nadie la compare,
 * no. (Mismo criterio que `CAPACIDADES` en `identidad/capacidades.ts`.)
 */
export const ESTADOS_DE_PEDIDO = [
  'creado',
  'reservado',
  'pagado',
  'repartido',
  'cancelado',
] as const

export function esEstadoDePedido(valor: unknown): valor is EstadoPedido {
  return typeof valor === 'string' && (ESTADOS_DE_PEDIDO as readonly string[]).includes(valor)
}

/**
 * Los estados en los que hay plata RETENIDA en la billetera del comprador.
 *
 * Hoy es uno solo, y aun asi es un conjunto y no un `=== 'reservado'`: de acá sale
 * el efecto de cada transicion sobre el dinero, y el dia que aparezca un segundo
 * estado retenedor —`en_disputa`, por ejemplo— agregarlo a este conjunto arregla
 * todas las transiciones a la vez en vez de pedir que alguien se acuerde de
 * revisarlas una por una.
 */
export const RETIENEN_PLATA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>(['reservado'])

/**
 * Los estados en los que PUEDE haber plata retenida SIN QUE EL ESTADO LO DIGA.
 *
 * Esto no estaba en la primera version de la 1.3, y su ausencia costo el defecto
 * mas caro que midieron las auditorias. El encabezado afirmaba que un pedido en
 * `creado` «afirma cero retencion y hay cero retencion: no miente». Miente: el
 * orquestador reserva en la billetera y DESPUES anota `reservado` en D1, asi que
 * entre las dos cosas hay una ventana en la que el pedido dice `creado` y la plata
 * ya esta retenida a su nombre.
 *
 * Declararlo cambia la pregunta que el codigo se hace. La vieja era «¿este estado
 * retiene?» —una afirmacion sobre la billetera que el pedido no puede hacer—. La
 * nueva es «¿puede haber algo retenido acá?», que es lo unico que se sabe de este
 * lado de la frontera.
 *
 * `pagado`, `repartido` y `cancelado` NO estan: los tres se alcanzan pasando por
 * una operacion que dejo la reserva cerrada, o por `cancelado`, que libera antes de
 * escribirse.
 */
export const RETENCION_INCIERTA: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>(['creado'])

/**
 * Los caminos. Todo lo que no esta acá no existe.
 *
 * Se lee «desde → los que se puede alcanzar»:
 *
 *   creado    → reservado  (la reserva salio bien: la plata quedo retenida)
 *   creado    → cancelado  (se pide liberar igual: puede haber una reserva viva
 *                          que D1 todavia no anoto — ver `efectoSobreLaReserva`)
 *   reservado → pagado     (la reserva se consume: la plata sale)
 *   reservado → cancelado  (la reserva se libera: la plata vuelve)
 *   pagado    → repartido  (se reparte lo cobrado)
 *   repartido → ∅          terminal
 *   cancelado → ∅          terminal
 *
 * `creado → pagado` NO esta a proposito, y es distinto de la ausencia de
 * `pagado → cancelado`: no es una decision de negocio, es una imposibilidad
 * mecanica. Cobrar es consumir una reserva, y un pedido en `creado` no tiene
 * ninguna reserva que consumir. Escrito el camino, `efectoSobreLaReserva` diria
 * «ninguno» —ningun estado retiene, antes ni despues— y el pedido quedaria cobrado
 * sin que se moviera un guarani.
 */
export const TRANSICIONES: ReadonlyMap<EstadoPedido, readonly EstadoPedido[]> = new Map<
  EstadoPedido,
  readonly EstadoPedido[]
>([
  ['creado', ['reservado', 'cancelado']],
  ['reservado', ['pagado', 'cancelado']],
  ['pagado', ['repartido']],
  ['repartido', []],
  ['cancelado', []],
])

/**
 * Un estado del que no sale ningun camino. Se DERIVA de la tabla, no se declara
 * aparte: una lista `TERMINALES = ['repartido', 'cancelado']` escrita al lado es
 * una lista que un dia contradice a la tabla, y la contradiccion no la nota nadie
 * hasta que un pedido terminal acepta una transicion.
 */
export function esTerminal(estado: EstadoPedido): boolean {
  return (TRANSICIONES.get(estado) ?? []).length === 0
}

export type MotivoInvalida = 'estado_terminal' | 'transicion_no_declarada' | 'mismo_estado'

export type Veredicto =
  | { readonly puede: true }
  | { readonly puede: false; readonly motivo: MotivoInvalida }

const SI: Veredicto = { puede: true }
const no = (motivo: MotivoInvalida): Veredicto => ({ puede: false, motivo })

/**
 * ¿Se puede ir de aca para alla?
 *
 * PRECEDENCIA DECLARADA de los motivos, en este orden y no en otro:
 *
 *   1. `mismo_estado` gana sobre todo. Reintentar una transicion que ya se
 *      aplico es lo que hace un cliente que perdio la respuesta, y contestarle
 *      «transicion no declarada» lo manda a buscar un defecto que no existe.
 *      Que sea un «no» y no un «si» es a proposito: el llamador tiene que poder
 *      distinguir «lo hice yo ahora» de «ya estaba», porque de eso depende si
 *      escribe un renglon de bitacora que diga que paso algo.
 *   2. `estado_terminal` gana sobre `transicion_no_declarada`. Las dos son
 *      «no», y la primera dice ADEMAS que ningun reintento con ningun destino va
 *      a funcionar nunca. Es la diferencia entre «probá otra cosa» y «pará».
 */
export function puedeTransicionar(desde: EstadoPedido, hacia: EstadoPedido): Veredicto {
  if (desde === hacia) return no('mismo_estado')
  if (esTerminal(desde)) return no('estado_terminal')
  if (!(TRANSICIONES.get(desde) ?? []).includes(hacia)) return no('transicion_no_declarada')
  return SI
}

export class TransicionInvalida extends Error {
  constructor(
    readonly desde: EstadoPedido,
    readonly hacia: EstadoPedido,
    readonly motivo: MotivoInvalida,
  ) {
    super(`no se puede pasar de ${desde} a ${hacia}: ${motivo}`)
    this.name = 'TransicionInvalida'
  }
}

/**
 * La transicion, o el error. Existe para que ningun llamador pueda quedarse con el
 * veredicto y avanzar igual: el que quiere el estado nuevo tiene que pasar por acá.
 */
export function transicionar(desde: EstadoPedido, hacia: EstadoPedido): EstadoPedido {
  const v = puedeTransicionar(desde, hacia)
  if (!v.puede) throw new TransicionInvalida(desde, hacia, v.motivo)
  return hacia
}

/**
 * Que hay que hacerle a la reserva de la billetera al aplicar esta transicion.
 *
 *   · `reservar` — se entra a un estado que retiene: hay que retener.
 *   · `consumir` — se sale de un estado que retiene porque se cobro: la plata sale.
 *   · `liberar`  — se va a `cancelado`: SOLTA LO QUE HAYA. Puede no haber nada.
 *   · `ninguno`  — la plata no se mueve.
 *
 * ---------------------------------------------------------------------------
 * POR QUE IR A `cancelado` SIEMPRE LIBERA, AUNQUE EL ESTADO DIGA QUE NO HAY NADA
 *
 * Esta es la correccion mas cara de la 1.3 y la midieron las dos vueltas de
 * auditoria, cada una por su lado.
 *
 * La version anterior derivaba el efecto SOLO de `RETIENEN_PLATA`, asi que
 * `creado → cancelado` daba `ninguno` — con este razonamiento escrito: «nunca se
 * retuvo nada; no hay plata que devolver». El razonamiento asume que el estado del
 * pedido SABE donde esta la plata, y no lo sabe: es una hipotesis. La fuente de
 * verdad es la billetera.
 *
 * El estado `creado` CON la reserva viva es alcanzable, y no hace falta nada
 * exotico: el orquestador reserva en la billetera y despues anota `reservado` en D1,
 * y entre las dos cosas hay una ventana. Medido de punta a punta:
 *
 *     retenido antes de cancelar : 45.000
 *     POST /pedidos/<id>/cancelar: 200 {"estado":"cancelado","cancelado":true}
 *     retenido despues           : 45.000
 *     segundo intento            : 200 {"cancelado":false}
 *
 * `cancelado` es TERMINAL, asi que no hay ningun camino de codigo que vuelva a
 * pasar por ahi: 45.000 Gs. retenidos, sin pedido que los reclame. Los rescata la
 * alarma de la billetera a la media hora, y si esa alarma se pierde —cosa que
 * `index.ts` declara posible— no los rescata nadie.
 *
 * Asi que cancelar SIEMPRE pide liberar. Liberar una reserva que no existe es un
 * no-op barato del lado del orquestador (`pedidos.ts` lo tolera explicitamente);
 * dejar plata retenida en un estado terminal no tiene arreglo.
 *
 * ---------------------------------------------------------------------------
 * LO QUE SIGUE SIENDO DERIVADO, y por que importa
 *
 * `reservar` y `consumir` salen de `RETIENEN_PLATA`, no de una tabla escrita a
 * mano. Una tabla de efectos al lado es la unica forma de que exista la linea
 * `reservado → cancelado: ninguno`, que deja plata retenida en un pedido cancelado
 * sin romper una sola prueba de transiciones. Derivada, esa linea no se puede
 * escribir — y ahora tampoco se puede escribir para `creado`.
 */
export type EfectoSobreLaReserva = 'ninguno' | 'reservar' | 'consumir' | 'liberar'

export function efectoSobreLaReserva(
  desde: EstadoPedido,
  hacia: EstadoPedido,
): EfectoSobreLaReserva {
  // LA PREGUNTA ES «¿PUEDE HABER ALGO RETENIDO ACA?», y no «¿este estado retiene?».
  // La primera es sobre lo que este lado de la frontera sabe; la segunda es una
  // afirmacion sobre la billetera que el pedido no esta en condiciones de hacer.
  //
  // La version anterior derivaba solo de `RETIENEN_PLATA`, y el arnes de mutacion
  // encontro despues que `RETENCION_INCIERTA` era una declaracion que no gobernaba
  // nada: vaciarla no rompia ninguna prueba, porque el `hacia === 'cancelado'` estaba
  // escrito aparte. Una declaracion que no gobierna es un comentario con sintaxis.
  const puedeHaberRetencion = RETIENEN_PLATA.has(desde) || RETENCION_INCIERTA.has(desde)
  const retieneDespues = RETIENEN_PLATA.has(hacia)

  // Se sale de un estado donde puede haber plata retenida hacia uno donde no la hay:
  // hay que hacer algo con ella. Hacia `cancelado` se devuelve, hacia cualquier otro
  // lado se cobro.
  if (puedeHaberRetencion && !retieneDespues) {
    return hacia === 'cancelado' ? 'liberar' : 'consumir'
  }

  // Se entra a un estado que retiene desde uno que todavia no retenia.
  if (retieneDespues && !RETIENEN_PLATA.has(desde)) return 'reservar'

  return 'ninguno'
}
