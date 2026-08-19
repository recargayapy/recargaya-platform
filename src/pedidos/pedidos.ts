/**
 * El pedido, del lado de afuera de la funcion pura: la fila de D1, el numero que
 * sale de la secuencia, y la reserva de plata que lo acompaña.
 *
 * Este archivo traduce entre filas y tipos, y ORQUESTA — que es lo que lo hace
 * distinto de `identidad/personas.ts`. Crear un pedido toca tres cosas que no
 * comparten transaccion: un Durable Object que numera, una tabla de D1, y otro
 * Durable Object que retiene plata. Todo lo interesante de este archivo es el
 * ORDEN en que las toca y que queda cuando se corta en el medio.
 *
 * La decision de que caminos existen NO vive acá: vive en `pedido.ts`, que es puro.
 * Acá se aplica.
 *
 * ---------------------------------------------------------------------------
 * LA REGLA DE ORDEN, UNA SOLA, Y LAS DOS FORMAS QUE TOMA
 *
 * No hay transaccion que abarque a D1 y a un Durable Object. Entonces cada paso hay
 * que ordenarlo pensando en QUE QUEDA SI EL WORKER MUERE JUSTO AHI. La regla es:
 *
 *     el estado del pedido nunca puede afirmar MENOS retencion que la realidad
 *     sin que quede un camino para arreglarlo.
 *
 * Se aplica en los dos sentidos y da respuestas opuestas, y por eso conviene verla
 * escrita una vez en lugar de discutirla dos:
 *
 *   · AL CREAR: primero el pedido, despues la plata. El peor estado alcanzable es un
 *     pedido en `creado` CON LA RESERVA YA HECHA y D1 sin enterarse — o sea que
 *     afirma MENOS retencion que la realidad. Es recuperable por dos caminos: el
 *     reintento con la misma `clave_idem` termina de reservar (`asegurarReserva`), y
 *     cancelar desde `creado` suelta igual, porque `RETENCION_INCIERTA` dice que ahi
 *     puede haber plata. Al reves —reservar primero— el peor estado es plata retenida
 *     a nombre de un pedido que NO EXISTE, y no hay a quien preguntarle por ella ni
 *     forma de reintentar.
 *
 *     (La version anterior de esta viñeta decia que un pedido en `creado` «afirma cero
 *     retencion y hay cero retencion: no miente». Es falso, lo midio una auditoria, y
 *     de ahi salio `RETENCION_INCIERTA`. La frase quedo escrita acá una vuelta mas de
 *     lo que debia, y la encontro la segunda vuelta leyendo los dos archivos juntos.)
 *
 *   · AL CANCELAR: primero la plata, despues el pedido. El peor estado alcanzable
 *     es un pedido en `reservado` cuya reserva ya se libero. Afirma retencion de
 *     mas, o sea que peca del lado seguro, y tiene arreglo: cancelar de nuevo pasa
 *     por `liberarReserva`, que contesta «ya estaba» sin mover un guarani, y
 *     termina el trabajo. Al reves —cancelar primero— queda un pedido `cancelado`
 *     con la plata todavia retenida, y `cancelado` es TERMINAL: `puedeTransicionar`
 *     no deja volver a intentar, asi que esa plata no tiene quien la suelte.
 *
 * Es una sola regla mirada de los dos lados, y no dos criterios distintos. La
 * primera version de este archivo tenia el orden de cancelar al reves «por
 * consistencia con el de crear».
 *
 * ---------------------------------------------------------------------------
 * POR QUE `reserva_id = pedido_id`, Y QUE PRECIO TIENE
 *
 * Decision del dueño, 18/08/2026: la reserva se llama como el pedido. Asi, mirando
 * la bolsa `retenido` de una billetera se sabe de que pedido es cada guarani sin
 * consultar nada.
 *
 * El precio hay que decirlo entero porque es real: `reservar()` se niega a reusar
 * un `reserva_id` AUNQUE ESTE CERRADO —lo decidio una auditoria de la 1.1 que midio
 * tres daños distintos del reuso— asi que UN PEDIDO PUEDE RESERVAR UNA SOLA VEZ EN
 * SU VIDA. Cancelado y vuelto a intentar, no hay reintento posible: es un pedido
 * nuevo, con numero nuevo.
 *
 * Eso NO impide el reintento de una peticion cortada, que es lo que la gente
 * necesita de verdad, y la razon es la idempotencia de la propia billetera: la
 * `clave_idem` de la operacion de reserva se DERIVA del pedido (`claveDeReserva`),
 * asi que un segundo intento de reservar el mismo pedido entra por `puertaDeEntrada`
 * y nunca llega a la linea que se niega a reusar el id.
 *
 * Lo que ese segundo intento recibe depende de la reserva, no de la puerta: si sigue
 * ABIERTA, `repetida: true` con el mismo resultado; si ya se cerro —la vencio la
 * alarma— `ReservaYaNoEstaAbierta`, y entonces el pedido esta muerto y se cierra. Ver
 * `reservar()` en `billetera/nucleo.ts`. (La version anterior de este parrafo decia
 * solo lo primero, y quedo describiendo el mundo de antes de ese guarda.)
 *
 * Si esa clave se dejara elegir al llamador, un reintento con clave distinta si
 * llegaria a esa linea, y saldria como 500. Por eso se deriva y no se recibe.
 */

import type { BilleteraDO, SecuenciaDO } from '../index.js'
import {
  type EfectoSobreLaReserva,
  type EstadoPedido,
  type MotivoInvalida,
  efectoSobreLaReserva,
  esEstadoDePedido,
  puedeTransicionar,
} from './pedido.js'
import { type Persona } from '../identidad/capacidades.js'
import { cargarPersona } from '../identidad/personas.js'
import {
  RESERVA_DESCONOCIDA,
  RESERVA_NACE_VENCIDA,
  RESERVA_YA_NO_ESTA_ABIERTA,
  SALDO_INSUFICIENTE,
} from '../billetera/nucleo.js'
import { type Instante, anioEnZona, instante, instanteOpcional } from '../dinero/momento.js'
import { type Guaranies, guaranies } from '../dinero/monto.js'
import { registrarIntencion, sentenciaDeBitacora, sentenciaDeBitacoraSi } from '../bitacora/bitacora.js'
import { actorId, type Actor } from '../identidad/actor.js'

/**
 * Como se llama el objeto de la secuencia de un año, en un solo lugar.
 *
 * Misma razon que `derivarBilleteraId`: dos lugares que arman el nombre a mano son
 * dos lugares que un dia arman nombres distintos, y ahi hay dos contadores dando
 * los mismos numeros.
 */
export function nombreDeLaSecuencia(anio: number): string {
  return `secuencia:${anio}`
}

/**
 * La forma del numero de pedido vive en `numero.ts` y se re-exporta desde acá para
 * que los llamadores tengan una sola puerta. Se valida por la misma razon que
 * `PERSONA_VALIDA` en `api/rutas.ts`: este texto termina en `pedidos.id`, en
 * `bitacora.objetivo` y —via `reserva_id = pedido_id`— adentro del nombre de una
 * reserva de plata.
 */
export { PEDIDO_VALIDO, pedidoIdValido } from './numero.js'

/**
 * La `clave_idem` con la que este pedido reserva. DERIVADA, nunca recibida — ver
 * el encabezado.
 */
export function claveDeReserva(pedido_id: string): string {
  return `pedido:${pedido_id}:reserva`
}

/** Y la de soltarla. Distinta de la de reservar: son dos operaciones, y la puerta
 *  de idempotencia de la billetera las distingue por esta clave. Con la misma, la
 *  liberacion saldria como «repetida» de la reserva y no soltaria nada. */
export function claveDeLiberacion(pedido_id: string): string {
  return `pedido:${pedido_id}:liberacion`
}

/**
 * Todo lo que este archivo escribe en D1 pasa por acá.
 *
 * Mismo motivo que el `enUnLote` de `identidad/personas.ts`, y el segundo lo pidio
 * el arnes de mutacion: con `d1.batch(...)` escrito en cuatro lugares, la mutacion
 * que rompe la atomicidad tiene que romper los cuatro, y una mutacion que muta a
 * medias muere o sobrevive por un motivo distinto al que declara. Acá se rompe uno.
 *
 * Un `batch()` de D1 es una transaccion: o entran el cambio y su renglon de
 * bitacora, o no entra ninguno de los dos.
 */
function enUnLote(d1: D1Database, sentencias: D1PreparedStatement[]): Promise<D1Result[]> {
  return d1.batch(sentencias)
}

export interface Pedido {
  readonly id: string
  readonly comprador_id: string
  readonly monto: Guaranies
  readonly estado: EstadoPedido
  readonly clave_idem: string
  /** Cuando vence la retencion. `null` = este pedido no tiene plata retenida. */
  readonly reserva_vence_en: Instante | null
  readonly creado_en: Instante
  readonly actualizado_en: Instante
}

export class PedidoNoExiste extends Error {
  constructor(readonly pedido_id: string) {
    super(`no existe el pedido ${pedido_id}`)
    this.name = 'PedidoNoExiste'
  }
}

/**
 * La misma `clave_idem` con OTRO contenido.
 *
 * Es el defecto que una clave de idempotencia mal implementada regala: devolver el
 * pedido que ya existia sin mirar si es el mismo pedido. Dos llamadores que eligen
 * la misma clave —`carga:1`, que alguien va a escribir— se llevarian el pedido del
 * otro, con su monto y su comprador adentro. Se contesta 409 y se pide otra clave.
 */
export class ClaveIdemRepetida extends Error {
  constructor(readonly clave_idem: string) {
    super(`la clave de idempotencia ${clave_idem} ya se uso para otro pedido`)
    this.name = 'ClaveIdemRepetida'
  }
}

/** No hay camino de este estado a `cancelado`. Lleva el motivo de `pedido.ts`. */
export class PedidoNoCancelable extends Error {
  constructor(
    readonly pedido_id: string,
    readonly estado: EstadoPedido,
    readonly motivo: MotivoInvalida,
  ) {
    super(`el pedido ${pedido_id} esta en ${estado} y no se puede cancelar: ${motivo}`)
    this.name = 'PedidoNoCancelable'
  }
}

/**
 * La ventana de reserva de este pedido ya paso, o su reserva murio antes de que D1
 * la anotara. En los dos casos el pedido queda CANCELADO y no hay reintento posible
 * con la misma `clave_idem`: `reserva_id = pedido_id` no se reusa, asi que reintentar
 * es un pedido nuevo con numero nuevo. Sale dicho en el 409.
 */
export class VentanaDeReservaVencida extends Error {
  constructor(
    readonly pedido_id: string,
    readonly vence_en: string,
  ) {
    super(`la ventana de reserva del pedido ${pedido_id} vencio el ${vence_en}`)
    this.name = 'VentanaDeReservaVencida'
  }
}

export class SaldoInsuficienteParaElPedido extends Error {
  constructor(readonly pedido_id: string) {
    super(`el comprador no tiene saldo para el pedido ${pedido_id}`)
    this.name = 'SaldoInsuficienteParaElPedido'
  }
}

/**
 * Lo que este modulo necesita del entorno, y nada mas. Mismo criterio que
 * `Dependencias` en `api/rutas.ts`, y los dos Durable Objects entran como TIPO
 * (`import type`) para que no quede un ciclo en tiempo de ejecucion con `index.ts`.
 */
export interface Puertas {
  readonly CORE: D1Database
  readonly BILLETERA: DurableObjectNamespace<BilleteraDO>
  readonly SECUENCIA: DurableObjectNamespace<SecuenciaDO>
  /** De donde sale el AÑO del numero de pedido. Ver `anioEnZona`. */
  readonly ZONA_HORARIA: string
}

export interface Contexto {
  readonly actor: Actor
  readonly correlacion_id: string
  readonly momento: Instante
}

/**
 * EL INSTANTE CON EL QUE SE SELLA UN CAMBIO SOBRE UNA FILA QUE YA EXISTE.
 *
 * `pedidos` tiene `CHECK (actualizado_en >= creado_en)` — una fila no se puede
 * modificar antes de existir. La segunda vuelta de auditoria midio adonde llevaba
 * usar `ctx.momento` a secas:
 *
 *     intento 1: 500  {"error":"fallo_interno"}   retenido = 25.000
 *     intento 2: 500  {"error":"fallo_interno"}   retenido = 25.000
 *     cancelar : 500  {"error":"fallo_interno"}   retenido = 25.000
 *     [cause] CHECK constraint failed: actualizado_en >= creado_en
 *
 * O sea: el UPDATE explota DESPUES de que `reservar()` ya movio la plata, el pedido
 * queda huerfano en `creado` para siempre, su `clave_idem` queda quemada, y las tres
 * rutas que lo tocan contestan 500. La plata vuelve recien con la alarma.
 *
 * COMO SE ALCANZA, y no hace falta ninguna maquina con el reloj roto: dos peticiones
 * con la misma `clave_idem`, y la que ARRANCO ANTES es la mas lenta. La rapida
 * inserta con `creado_en = t0`; la lenta trae `ctx.momento = t0 − 5 ms`, choca contra
 * el indice unico, releé la fila y entra a `asegurarReserva` con un momento anterior
 * al `creado_en`.
 *
 * La decision: sellar con el mayor de los dos. Un `actualizado_en` IGUAL al
 * `creado_en` es legitimo —el CHECK es `>=` justamente porque el proyecto ya acepto
 * la ventana de duracion cero en las capacidades— y es la respuesta correcta a «esto
 * se modifico en el mismo instante en que nacio, o antes de que mi reloj se enterara».
 *
 * SE COMPARA CONTRA `actualizado_en` Y NO CONTRA `creado_en`, y eso lo corrigio la
 * segunda vuelta. La primera version usaba `max(momento, creado_en)` —lo justo para
 * que el CHECK no explotara— y con eso la columna podia RETROCEDER respecto de su
 * propio valor anterior. Medido:
 *
 *     actualizado_en antes  : 2026-08-19T16:06:14.402Z
 *     actualizado_en despues: 2026-08-19T15:56:14.409Z
 *
 * Diez minutos para atras, y el CHECK ni se entera porque solo mira `creado_en`. Hoy
 * no rompe nada —nadie ordena por esa columna— y el dia que alguien haga sincronizacion
 * incremental por `actualizado_en > ultimo_visto`, que es el uso natural, ese pedido
 * desaparece del delta. Comparar contra `actualizado_en` implica `>= creado_en` por el
 * propio CHECK, asi que cierra la categoria en vez del caso que hizo explotar la base.
 *
 * Lo que NO se hace: mentir hacia adelante. No se inventa un instante posterior.
 */
export function selloDe(ctx: Contexto, pedido: Pedido): Instante {
  return ctx.momento < pedido.actualizado_en ? pedido.actualizado_en : ctx.momento
}

interface FilaPedido {
  id: string
  comprador_id: string
  monto: number
  estado: string
  clave_idem: string
  reserva_vence_en: string | null
  creado_en: string
  actualizado_en: string
}

const COLUMNAS =
  'id, comprador_id, monto, estado, clave_idem, reserva_vence_en, creado_en, actualizado_en'

/**
 * Arma el pedido desde su fila, validando lo que llega de la base.
 *
 * Se valida aunque la fila salga de nuestra propia tabla, por lo mismo que
 * `armarPersona`: el CHECK lo aplica la base que corre HOY, y una fila escrita por
 * una version anterior del esquema o por una consulta a mano entra igual. Un
 * `estado` que no se reconoce no puede caer en un `else` que lo trate como `creado`
 * — seria un pedido repartido volviendo a la cola.
 */
function armarPedido(fila: FilaPedido): Pedido {
  if (!esEstadoDePedido(fila.estado)) {
    throw new Error(`estado desconocido en el pedido ${fila.id}: ${fila.estado}`)
  }
  return {
    id: fila.id,
    comprador_id: fila.comprador_id,
    monto: guaranies(fila.monto),
    estado: fila.estado,
    clave_idem: fila.clave_idem,
    reserva_vence_en: instanteOpcional(fila.reserva_vence_en),
    creado_en: instante(fila.creado_en),
    actualizado_en: instante(fila.actualizado_en),
  }
}

export async function cargarPedido(d1: D1Database, pedido_id: string): Promise<Pedido | null> {
  const fila = await d1
    .prepare(`SELECT ${COLUMNAS} FROM pedidos WHERE id = ?`)
    .bind(pedido_id)
    .first<FilaPedido>()
  return fila === null ? null : armarPedido(fila)
}

export async function pedidoPorClave(d1: D1Database, clave_idem: string): Promise<Pedido | null> {
  const fila = await d1
    .prepare(`SELECT ${COLUMNAS} FROM pedidos WHERE clave_idem = ?`)
    .bind(clave_idem)
    .first<FilaPedido>()
  return fila === null ? null : armarPedido(fila)
}

export interface EntradaDePedido {
  readonly monto: Guaranies
  readonly clave_idem: string
}

// `reserva_vence_en` NO entra por acá, y estuvo declarado como campo muerto hasta que
// la segunda vuelta de auditoria lo midio: la ruta lo pasaba, nadie lo leia, y un
// `Instante` obligatorio en la interfaz hacia creer que gobernaba la ventana. Lo
// decide `venceEnDeLaReserva`, y el porque esta escrito ahi.

/**
 * Traduce el efecto que la maquina de estados declara a la operacion de la
 * billetera que le corresponde.
 *
 * Existe para que la unica fuente de «que hay que hacerle a la plata» sea
 * `efectoSobreLaReserva`, y para que el dia que aparezca una transicion nueva este
 * `switch` sea lo que se rompe. `consumir` todavia no tiene implementacion —cobrar
 * es de otra entrega— y por eso tira un error que dice exactamente eso, en lugar
 * de caer en un `default` que no haga nada. Un efecto ignorado en silencio es plata
 * que se queda retenida con el pedido diciendo que se cobro.
 */
function exigirEfecto(esperado: EfectoSobreLaReserva, desde: EstadoPedido, hacia: EstadoPedido): void {
  const real = efectoSobreLaReserva(desde, hacia)
  if (real !== esperado) {
    throw new Error(
      `la transicion ${desde} -> ${hacia} pide "${real}" sobre la reserva y acá se iba a hacer "${esperado}"`,
    )
  }
}

/**
 * Crea el pedido y le reserva la plata. LA funcion de la entrega 1.3.
 *
 * Devuelve `repetido: true` cuando la `clave_idem` ya habia creado este pedido — lo
 * que ve un llamador que reintenta una peticion cortada.
 */
export async function crearPedido(
  p: Puertas,
  ctx: Contexto,
  comprador: Persona,
  entrada: EntradaDePedido,
): Promise<{ pedido: Pedido; repetido: boolean }> {
  // 1 · ¿Ya existe? Este es el camino del reintento, y es el primero a proposito:
  // sin esto, un reintento saca un numero de la secuencia antes de descubrir que no
  // hacia falta, y ese numero queda como hueco.
  const ya = await pedidoPorClave(p.CORE, entrada.clave_idem)
  if (ya !== null) {
    if (ya.comprador_id !== comprador.persona_id || ya.monto !== entrada.monto) {
      throw new ClaveIdemRepetida(entrada.clave_idem)
    }
    // Puede estar a medio nacer: `asegurarReserva` termina el trabajo o no hace
    // nada, segun el estado.
    return { pedido: await asegurarReserva(p, ctx, comprador, ya), repetido: true }
  }

  // 2 · El numero. Sale ANTES del INSERT porque es la clave primaria de la fila.
  // Si algo falla despues, el numero queda como hueco — decision tomada, ver
  // `SecuenciaDO`.
  const anio = anioEnZona(ctx.momento, p.ZONA_HORARIA)
  const secuencia = p.SECUENCIA.get(p.SECUENCIA.idFromName(nombreDeLaSecuencia(anio)))
  const pedido_id = await secuencia.siguiente(anio)

  // 3 · La fila y su renglon de bitacora, en el MISMO `batch()`. Ley 5 del lado de
  // D1, igual que en `identidad/personas.ts`.
  const fila: Pedido = {
    id: pedido_id,
    comprador_id: comprador.persona_id,
    monto: entrada.monto,
    estado: 'creado',
    clave_idem: entrada.clave_idem,
    reserva_vence_en: null,
    creado_en: ctx.momento,
    actualizado_en: ctx.momento,
  }

  try {
    await enUnLote(p.CORE, [
      p.CORE.prepare(
        `INSERT INTO pedidos (${COLUMNAS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        fila.id,
        fila.comprador_id,
        fila.monto,
        fila.estado,
        fila.clave_idem,
        fila.reserva_vence_en,
        fila.creado_en,
        fila.actualizado_en,
      ),
      sentenciaDeBitacora(p.CORE, {
        actor_id: actorId(ctx.actor),
        accion: 'pedido.creado',
        objetivo: pedido_id,
        // Ley 9: identificadores y montos, nunca el nombre de nadie.
        detalle: { comprador_id: comprador.persona_id, monto: entrada.monto, clave_idem: entrada.clave_idem },
        correlacion_id: ctx.correlacion_id,
        ocurrido_en: ctx.momento,
      }),
    ])
  } catch (e) {
    // El indice unico sobre `clave_idem` es lo que decide de verdad: entre la
    // lectura del paso 1 y este INSERT cabe otra peticion con la misma clave. La
    // lectura da el mensaje entendible; esto es lo que hace imposible el duplicado.
    // Mismo par de guardas que 0003 puso sobre las ventanas de capacidad.
    const otro = await pedidoPorClave(p.CORE, entrada.clave_idem)
    if (otro === null) throw e
    if (otro.comprador_id !== comprador.persona_id || otro.monto !== entrada.monto) {
      throw new ClaveIdemRepetida(entrada.clave_idem)
    }
    return { pedido: await asegurarReserva(p, ctx, comprador, otro), repetido: true }
  }

  return { pedido: await asegurarReserva(p, ctx, comprador, fila), repetido: false }
}

/**
 * Le reserva la plata a un pedido que todavia no la tiene. Idempotente.
 *
 * Es el paso que puede quedar sin hacer si el Worker muere despues del INSERT, y
 * por eso es una funcion aparte que se puede volver a llamar: la llama tanto la
 * creacion como cualquier reintento con la misma `clave_idem`.
 *
 * SIN SALDO SE CANCELA EL PEDIDO, y hay que decir por que y que cuesta.
 *
 * Un pedido que no pudo reservar es basura: no tiene plata, no avanza, y ocupa un
 * numero. Dejarlo en `creado` significa que alguien tiene que barrerlo despues, y
 * mientras tanto el comprador ve un pedido pendiente que nunca va a pasar nada.
 * Se cancela en el momento, por `cancelarPedido` — que es el UNICO camino a
 * `cancelado` y siempre le pide a la billetera que suelte lo que haya. Que acá no haya
 * nada que soltar es lo esperable y no lo que sostiene la correccion: lo que la
 * sostiene es que no hay ninguna forma de llegar a un estado terminal sin haber
 * preguntado. Ver el encabezado de `cancelarPedido`.
 *
 * El precio: como la `clave_idem` ya quedo consumida por ese pedido cancelado, el
 * mismo llamador con la misma clave se lleva siempre el mismo pedido cancelado,
 * aunque despues cargue saldo. Es lo que una clave de idempotencia significa
 * —misma clave, mismo resultado— y la salida es una clave nueva. Sale dicho en el
 * mensaje del 409.
 */
export async function asegurarReserva(
  p: Puertas,
  ctx: Contexto,
  comprador: Persona,
  pedido: Pedido,
): Promise<Pedido> {
  if (pedido.estado !== 'creado') return pedido
  exigirEfecto('reservar', 'creado', 'reservado')

  const sello = selloDe(ctx, pedido)
  const vence_en = pedido.reserva_vence_en ?? venceEnDeLaReserva(pedido)

  // LA VENTANA YA VENCIO: este pedido no se puede completar, y hay que decirlo ahora.
  //
  // `venceEnDeLaReserva` deriva de `creado_en` a proposito —para que los dos intentos
  // calculen lo mismo— y la consecuencia es que un pedido que quedo en `creado` hace
  // mas de media hora reservaria con un vencimiento EN EL PASADO. Medido por las dos
  // vueltas de auditoria: la reserva nacia y la alarma la deshacia en milisegundos, y
  // el llamador se llevaba un 200 con `estado: reservado` sobre una billetera que no
  // retenia un guarani.
  //
  // `nucleo.reservar()` ahora tambien lo rechaza, y las dos comprobaciones hacen
  // falta: la del nucleo es la que lo hace imposible, esta es la que convierte el
  // fallo en un 409 con una explicacion, evita escribir en la bitacora append-only una
  // intencion que ya se sabe imposible, y deja el pedido cerrado en vez de colgado.
  //
  // Y CIERRA POR `cancelarPedido`, que suelta antes de cerrar. La primera version
  // llamaba a un atajo que cancelaba sin preguntarle nada a la billetera, y la segunda
  // vuelta de auditoria midio la consecuencia: la reserva podia seguir VIVA —la alarma
  // se atrasa, o se pierde— y quedaban 45.000 Gs. retenidos en un pedido terminal, sin
  // ninguna ruta que los soltara. El atajo ya no existe.
  if (vence_en <= ctx.momento) {
    await cancelarPedido(p, ctx, comprador, pedido, 'ventana_vencida')
    throw new VentanaDeReservaVencida(pedido.id, vence_en)
  }

  await registrarIntencion(p.CORE, {
    actor_id: actorId(ctx.actor),
    accion: 'pedido.reserva.pedida',
    objetivo: pedido.id,
    detalle: { billetera_id: comprador.billetera_id, monto: pedido.monto, vence_en },
    correlacion_id: ctx.correlacion_id,
    ocurrido_en: ctx.momento,
  })

  const billetera = p.BILLETERA.get(p.BILLETERA.idFromName(comprador.billetera_id))
  try {
    await billetera.reservar(
      {
        // DERIVADA. Ver el encabezado: es lo que hace que el reintento entre por la
        // puerta de idempotencia en vez de chocar contra «un reserva_id no se reusa».
        clave_idem: claveDeReserva(pedido.id),
        correlacion_id: ctx.correlacion_id,
        momento: ctx.momento,
      },
      { reserva_id: pedido.id, monto: pedido.monto, vence_en },
    )
  } catch (e) {
    // Se compara el TEXTO y no la clase, y eso no es pereza: del otro lado de un
    // Durable Object el RPC serializa el error, asi que `instanceof SaldoInsuficiente`
    // es siempre falso acá. Las constantes vienen de `nucleo.ts` para que el que
    // compara y el que escribe el mensaje no puedan divergir.
    const mensaje = e instanceof Error ? e.message : ''

    if (mensaje.includes(SALDO_INSUFICIENTE)) {
      await cancelarPedido(p, ctx, comprador, pedido, 'saldo_insuficiente')
      throw new SaldoInsuficienteParaElPedido(pedido.id)
    }

    // LA RESERVA DE ESTE PEDIDO EXISTIO Y YA NO ESTA ABIERTA — la vencio la alarma
    // mientras D1 todavia decia `creado`. Y `reserva_id = pedido_id` no se reusa, asi
    // que este pedido NO puede volver a reservar nunca: esta muerto y hay que
    // cerrarlo, no dejarlo colgado esperando un reintento que no existe.
    //
    // Sin este bloque, la version anterior anotaba `reservado` sobre una reserva
    // muerta —la puerta de idempotencia contestaba «ya se aplico»— y el pedido
    // quedaba mintiendo para siempre. Lo midieron las dos vueltas de auditoria.
    if (mensaje.includes(RESERVA_YA_NO_ESTA_ABIERTA) || mensaje.includes(RESERVA_NACE_VENCIDA)) {
      await cancelarPedido(p, ctx, comprador, pedido, 'reserva_vencida')
      throw new VentanaDeReservaVencida(pedido.id, vence_en)
    }

    throw e
  }

  // La bitacora PRIMERO y condicionada al MISMO predicado que el UPDATE, las dos en
  // la misma transaccion. Es la leccion que dejo `revocarCapacidad`: condicionar el
  // registro sobre el valor recien escrito no es lo mismo que «el UPDATE toco una
  // fila», y con dos peticiones en el mismo milisegundo deja escrito que paso algo
  // que no paso.
  await enUnLote(p.CORE, [
    sentenciaDeBitacoraSi(
      p.CORE,
      {
        actor_id: actorId(ctx.actor),
        accion: 'pedido.reservado',
        objetivo: pedido.id,
        detalle: { monto: pedido.monto, vence_en },
        correlacion_id: ctx.correlacion_id,
        ocurrido_en: ctx.momento,
      },
      { sql: 'SELECT 1 FROM pedidos WHERE id = ? AND estado = ?', valores: [pedido.id, 'creado'] },
    ),
    p.CORE.prepare(
      'UPDATE pedidos SET estado = ?, reserva_vence_en = ?, actualizado_en = ? WHERE id = ? AND estado = ?',
    ).bind('reservado', vence_en, sello, pedido.id, 'creado'),
  ])

  // Se relee en vez de devolver el objeto armado en memoria. Cuesta un viaje y
  // paga: si el UPDATE toco cero filas —porque otra peticion en el mismo
  // milisegundo llego primero— lo devuelto es lo que la base tiene, no lo que esta
  // funcion creia estar escribiendo.
  const releido = await cargarPedido(p.CORE, pedido.id)
  if (releido === null) throw new PedidoNoExiste(pedido.id)
  return releido
}

/**
 * El vencimiento de la reserva de un pedido que todavia no lo tiene guardado.
 *
 * Que este acá y no en la entrada es deliberado: el reintento de una peticion
 * cortada tiene que reservar hasta el MISMO instante que el intento original, y el
 * intento original ya no esta para preguntarle. Con la duracion derivada del pedido
 * —su `creado_en` mas la ventana— los dos intentos calculan lo mismo sin
 * coordinarse.
 *
 * Se deriva de `creado_en` y no de `ctx.momento` por eso exactamente. Con
 * `ctx.momento`, cada reintento correria la ventana hacia adelante y un llamador
 * que reintenta cada minuto mantendria la plata retenida para siempre.
 */
export const VENTANA_DE_RESERVA_MS = 30 * 60 * 1000

export function venceEnDeLaReserva(pedido: Pedido): Instante {
  // Pasa por `instante()` en vez de confiar en `toISOString()`. Cuesta nada y es lo
  // que impide que una fecha imposible —`creado_en` corrupto, una suma que desborda
  // el rango de `Date`— llegue a la billetera como `'Invalid Date'`.
  return instante(new Date(Date.parse(pedido.creado_en) + VENTANA_DE_RESERVA_MS).toISOString())
}


/**
 * EL UNICO CAMINO A `cancelado`. Suelta la plata y despues cierra el pedido.
 *
 * PRIMERO LA PLATA, DESPUES EL PEDIDO. Es la otra mitad de la regla del encabezado:
 * `cancelado` es terminal, asi que un pedido cancelado con la reserva todavia abierta
 * no tiene quien la suelte nunca mas.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ES EL UNICO, Y NO UNO DE DOS
 *
 * Habia un segundo: `cerrarSinReserva`, que cancelaba sin preguntarle nada a la
 * billetera. Se justificaba asi: «acá se sabe con certeza que la billetera rechazo la
 * reserva, porque el rechazo es justamente lo que trajo hasta esta linea». Era cierto
 * para sus dos llamadores originales.
 *
 * Y despues la primera vuelta de auditoria hizo agregar un guarda —«la ventana ya
 * vencio»— que llama a esa misma funcion SIN ningun rechazo en la mano: se decide del
 * lado del orquestador, antes de tocar la billetera. La segunda vuelta lo midio:
 *
 *     reintento a los 31 min : 409 ventana_de_reserva_vencida
 *     pedido en D1           : cancelado
 *     retenido               : 45.000     ← la reserva seguia viva
 *     POST .../cancelar      : 200 {"cancelado": false}   (ya es terminal)
 *     POST /pedidos/conciliar: {"revisados": 0}           (ya no dice `reservado`)
 *
 * O sea: el arreglo de un agujero abrio el mismo agujero por otra puerta, y encima le
 * saco al pedido las dos redes que lo rescataban. Un comentario que prometia una
 * certeza que uno de sus tres llamadores no tenia.
 *
 * Se podia arreglar ESE llamador. Se arregla la categoria: hay UN camino a
 * `cancelado` y siempre suelta. Liberar una reserva que no existe cuesta un viaje al
 * Durable Object y no rompe nada; llegar a un estado terminal con plata adentro no
 * tiene arreglo.
 *
 * ---------------------------------------------------------------------------
 * Devuelve `cancelado: false` cuando ya estaba cancelado. Eso NO es un error: es un
 * reintento de una cancelacion que ya se aplico, y tiene que ser inofensivo — mismo
 * criterio que `revocarCapacidad`.
 *
 * `motivo` es lo que queda escrito en la bitacora. Los cuatro que hay hoy:
 * `pedida_por_el_actor`, `saldo_insuficiente`, `ventana_vencida` y `reserva_vencida`.
 */
export async function cancelarPedido(
  p: Puertas,
  ctx: Contexto,
  comprador: Persona,
  pedido: Pedido,
  motivo: string = 'pedida_por_el_actor',
): Promise<{ pedido: Pedido; cancelado: boolean }> {
  const v = puedeTransicionar(pedido.estado, 'cancelado')
  if (!v.puede) {
    if (v.motivo === 'mismo_estado') return { pedido, cancelado: false }
    throw new PedidoNoCancelable(pedido.id, pedido.estado, v.motivo)
  }

  // SIEMPRE SE SUELTA, mire lo que mire el estado. `efectoSobreLaReserva` contesta
  // `liberar` para todo camino hacia `cancelado`, y el porque esta entero en
  // `pedido.ts`: el estado del pedido es una HIPOTESIS sobre donde esta la plata, y
  // `cancelado` es terminal — lo que quede retenido al entrar, queda retenido para
  // siempre. `exigirEfecto` esta acá para que el dia que alguien cambie esa regla,
  // esta funcion se rompa en vez de dejar de soltar en silencio.
  exigirEfecto('liberar', pedido.estado, 'cancelado')

  await registrarIntencion(p.CORE, {
    actor_id: actorId(ctx.actor),
    accion: 'pedido.liberacion.pedida',
    objetivo: pedido.id,
    detalle: { billetera_id: comprador.billetera_id, monto: pedido.monto, desde: pedido.estado },
    correlacion_id: ctx.correlacion_id,
    ocurrido_en: ctx.momento,
  })

  const billetera = p.BILLETERA.get(p.BILLETERA.idFromName(comprador.billetera_id))
  try {
    await billetera.liberarReserva(
      {
        clave_idem: claveDeLiberacion(pedido.id),
        correlacion_id: ctx.correlacion_id,
        momento: ctx.momento,
      },
      { reserva_id: pedido.id },
    )
  } catch (e) {
    // «No hay ninguna reserva con ese nombre» es la respuesta ESPERADA cuando el
    // pedido nunca llego a reservar, que es la mayoria de las cancelaciones desde
    // `creado`. Se tolera acá y no se afloja el nucleo: para la billetera, liberar
    // una reserva que no existe sigue siendo un error del llamador —hay una prueba
    // que lo fija desde la 1.1— y el unico llamador con motivo legitimo para pedirlo
    // a ciegas es este, que no puede saber si la reserva alcanzo a nacer.
    //
    // El texto sale de una constante exportada por `nucleo.ts`: del otro lado de la
    // frontera del Durable Object el RPC serializa el error y `instanceof` no vale.
    if (!(e instanceof Error) || !e.message.includes(RESERVA_DESCONOCIDA)) throw e
  }

  const desde = pedido.estado
  const [, cambio] = await enUnLote(p.CORE, [
    sentenciaDeBitacoraSi(
      p.CORE,
      {
        actor_id: actorId(ctx.actor),
        accion: 'pedido.cancelado',
        objetivo: pedido.id,
        detalle: { desde, motivo },
        correlacion_id: ctx.correlacion_id,
        ocurrido_en: ctx.momento,
      },
      { sql: 'SELECT 1 FROM pedidos WHERE id = ? AND estado = ?', valores: [pedido.id, desde] },
    ),
    // `reserva_vence_en` vuelve a NULL: la columna dice «este pedido tiene plata
    // retenida hasta tal hora», y ya no la tiene.
    p.CORE.prepare(
      'UPDATE pedidos SET estado = ?, reserva_vence_en = NULL, actualizado_en = ? WHERE id = ? AND estado = ?',
    ).bind('cancelado', selloDe(ctx, pedido), pedido.id, desde),
  ])

  const releido = await cargarPedido(p.CORE, pedido.id)
  if (releido === null) throw new PedidoNoExiste(pedido.id)

  // `cancelado` sale de si ESTE UPDATE toco una fila, y no de si la fila quedo
  // cancelada. La segunda vuelta de auditoria midio la diferencia: dos cancelaciones
  // en el mismo milisegundo contestaban las dos `cancelado: true`, y un llamador que
  // manda «te devolvimos la plata» cuando ve `true` avisaba dos veces por una sola
  // devolucion.
  //
  // Es exactamente la distincion que `sentenciaDeBitacoraSi` documenta —«el UPDATE
  // toco una fila» no es lo mismo que «la fila esta asi»— aplicada a la bitacora en
  // la primera version y no a la respuesta. Ahora las dos salen del MISMO predicado.
  return { pedido: releido, cancelado: (cambio?.meta?.changes ?? 0) > 0 }
}

/**
 * EL CONCILIADOR DE RESERVAS VENCIDAS.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE, Y POR QUE NO PODIA QUEDAR COMO DEUDA
 *
 * La primera version de la 1.3 escribia `reserva_vence_en` y no la leia nunca. Las
 * dos vueltas de auditoria lo midieron con el mismo `grep`: la columna se escribia
 * en dos lugares, se leia solo para copiarla al JSON de la respuesta, y el indice
 * parcial `idx_pedidos_reserva_vence` estaba creado para un barrido que no existia.
 *
 * Y habia TRES comentarios prometiendolo. El encabezado de la migracion decia que
 * sin esa columna «D1 no tiene forma de saber que la plata que el pedido dice tener
 * retenida ya volvio a las bolsas» — cierto, y guardarla no arregla nada si nadie la
 * compara. Un comentario que promete lo que el codigo no hace es la causa raiz
 * declarada de este proyecto, y estaba tres veces en la misma entrega.
 *
 * El daño concreto, medido: la alarma de la billetera libera la reserva vencida y
 * devuelve la plata; el pedido queda en `reservado` PARA SIEMPRE. El panel, leyendo
 * el read model como manda la ley 1, muestra plata retenida que no existe.
 *
 * ---------------------------------------------------------------------------
 * QUE HACE, EXACTAMENTE
 *
 * Busca los pedidos que dicen retener plata cuya ventana ya paso, y los cancela por
 * el camino de siempre — `cancelarPedido`, que suelta lo que haya (si la alarma ya
 * lo solto, la billetera contesta «ya estaba» y no se mueve un guarani) y despues
 * escribe el estado. No hay un segundo camino de cancelacion: eso es a proposito,
 * porque dos caminos son dos que un dia divergen.
 *
 * NO LO LLAMA NADIE SOLO. Lo dispara `POST /pedidos/conciliar`, que hoy se invoca a
 * mano o desde un Cron Trigger. Que el disparador todavia no exista es deuda
 * declarada; que la consulta no existiera era una promesa falsa. Son cosas
 * distintas y esta es la que habia que cerrar en esta entrega.
 *
 * ---------------------------------------------------------------------------
 * EL TOPE, Y POR QUE SE INFORMA
 *
 * Se procesa de a `limite` pedidos y se devuelve CUANTOS QUEDARON. Un barrido sin tope
 * sobre una tabla que crece es un Worker que se queda sin tiempo justo cuando mas hay
 * para hacer. Y el que quedo pendiente se DICE en la respuesta en vez de desaparecer:
 * un tope silencioso se lee como «no habia nada mas».
 *
 * `quedan` ES UN CONTEO, y eso lo corrigio la segunda vuelta. La primera version pedia
 * un pedido de mas y contestaba `1` o `0` — un booleano disfrazado de numero, con este
 * mismo parrafo prometiendo un contador. Medido: 57 vencidos, tope 50, la respuesta
 * decia `quedan: 1` con 7 atrasados. Es peor que el tope silencioso que el parrafo dice
 * querer evitar: «queda uno» invita a un barrido mas y a dar el trabajo por cerrado.
 *
 * ---------------------------------------------------------------------------
 * DE DONDE SALE EL TOPE
 *
 * Cada pedido cuesta hoy CUATRO subpeticiones —la intencion, la liberacion contra el
 * Durable Object, el lote de bitacora+UPDATE, y la relectura— mas una consulta de
 * persona por comprador DISTINTO (se cachean: un comprador con la billetera caida deja
 * varios pedidos colgados, y era una consulta por pedido).
 *
 * Con veinticinco pedidos eso da ~101 subpeticiones, mas el SELECT y el COUNT. Entra
 * comodo en el limite de 1000 del plan pago. Con el tope anterior de 50 daban ~251, que
 * tambien entraba — pero el margen no es gratis: el que llame a esto desde un Cron
 * Trigger va a querer poder subirlo, y conviene que suba desde un numero que se pueda
 * defender. Lo midio la segunda vuelta contando el costo por pedido.
 */
export const TOPE_DE_CONCILIACION = 25

export async function conciliarReservasVencidas(
  p: Puertas,
  ctx: Contexto,
  limite: number = TOPE_DE_CONCILIACION,
): Promise<{ revisados: number; cancelados: number; quedan: number }> {
  // La consulta que el indice parcial de 0004 estaba esperando: `estado = 'reservado'`
  // y `reserva_vence_en <= momento`, comparado como TEXTO — que ordena igual que el
  // reloj porque los dos lados pasaron por `instante()`, con ancho fijo. Ver
  // `dinero/momento.ts`.
  const DONDE =
    "FROM pedidos WHERE estado = 'reservado' AND reserva_vence_en IS NOT NULL AND reserva_vence_en <= ?"

  // El total y el lote salen del MISMO predicado, en un solo viaje. Escrito en dos
  // consultas sueltas serian dos textos que un dia dicen cosas distintas, y el que
  // quedaria mal es el que le dice al operador cuanto falta.
  const [conteo, filas] = await p.CORE.batch<{ n: number } | FilaPedido>([
    p.CORE.prepare(`SELECT COUNT(*) AS n ${DONDE}`).bind(ctx.momento),
    p.CORE.prepare(`SELECT ${COLUMNAS} ${DONDE} ORDER BY reserva_vence_en LIMIT ?`).bind(
      ctx.momento,
      limite,
    ),
  ])

  const total = (conteo?.results?.[0] as { n: number } | undefined)?.n ?? 0
  const aRevisar = ((filas?.results ?? []) as FilaPedido[]).map(armarPedido)
  const quedan = Math.max(0, total - aRevisar.length)

  // Los compradores, cacheados. Un comprador con la billetera caida deja varios
  // pedidos colgados, y la version anterior consultaba la persona una vez por pedido:
  // con el tope lleno eran veinticinco consultas para una sola fila.
  const compradores = new Map<string, Persona | null>()

  let cancelados = 0
  for (const pedido of aRevisar) {
    if (!compradores.has(pedido.comprador_id)) {
      compradores.set(pedido.comprador_id, await cargarPersona(p.CORE, pedido.comprador_id))
    }
    const comprador = compradores.get(pedido.comprador_id) ?? null
    if (comprador === null) {
      // Un pedido cuyo comprador no existe es un descuadre que no se arregla
      // cancelando: no hay billetera a la que devolverle nada. Se registra y se
      // sigue, porque un pedido roto no puede frenar el barrido de los demas — es
      // el mismo criterio que `alarm()` usa con las liberaciones que fallan.
      console.error(
        `conciliacion: el pedido ${pedido.id} apunta a la persona ${pedido.comprador_id}, que no existe (correlacion ${ctx.correlacion_id})`,
      )
      continue
    }

    // Cada uno por separado: si uno falla, no arrastra a los demas.
    try {
      const r = await cancelarPedido(p, ctx, comprador, pedido, 'reserva_vencida')
      if (r.cancelado) cancelados += 1
    } catch (e) {
      console.error(
        `conciliacion: no se pudo cancelar el pedido vencido ${pedido.id} (correlacion ${ctx.correlacion_id})`,
        e,
      )
    }
  }

  return { revisados: aRevisar.length, cancelados, quedan }
}
