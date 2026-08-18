/**
 * Punto de entrada del Worker.
 *
 * En la Fase 0 esto es deliberadamente minimo: lo unico que hace falta es que
 * el proyecto despliegue y que los Durable Objects existan con sus fronteras
 * ya dibujadas. La logica del dinero ya esta escrita y probada en `src/`, sin
 * depender de este archivo.
 *
 * Las fronteras de Durable Object son LA decision de diseno del proyecto: dan
 * atomicidad perfecta adentro de un objeto y ninguna garantia entre objetos.
 * Se declaran ahora porque moverlas despues es imposible.
 */

import { DurableObject } from 'cloudflare:workers'
import {
  type EstadoBilletera,
  type Operacion,
  type Resultado,
  acreditar,
  debitar,
  reservar,
  liberarReserva,
  consumirReserva,
  verificarInvariantes,
  verificarDelta,
} from './billetera/nucleo.js'
import { ESQUEMA } from './billetera/esquema.js'
import { enUnaTransaccion } from './billetera/transaccion.js'
import {
  type Sql,
  cabezaDelOutbox,
  cargarEstado,
  contarIntento,
  guardarDelta,
  marcarPublicadas,
  outboxPendiente,
  reconciliar,
  reservasVencidas,
  resumenDelOutbox,
} from './billetera/repositorio.js'
import { LOTE, PASADAS_MAXIMAS, sentencias } from './billetera/publicador.js'
import { cuandoDespertar } from './billetera/alarma.js'
import { guaranies } from './dinero/monto.js'

export interface Entorno {
  readonly ENTORNO: string
  readonly ZONA_HORARIA: string
  readonly CORE: D1Database
  readonly BILLETERA: DurableObjectNamespace<BilleteraDO>
  readonly SECUENCIA: DurableObjectNamespace<SecuenciaDO>
}

/**
 * Una billetera por usuario. Serializa TODO movimiento de plata de esa cuenta.
 *
 * Sigue siendo una cascara delgada: persiste y delega. La logica del dinero vive
 * en `billetera/nucleo.ts`, que es puro y por lo tanto probable sin runtime; la
 * traduccion a tablas vive en `billetera/repositorio.ts`. Este archivo es el
 * unico que sabe de las dos cosas a la vez, y por eso es corto a proposito.
 *
 * QUE CAMBIO RESPECTO DE LA VERSION ANTERIOR, y por que
 *
 * Guardaba el estado entero como un JSON en la clave `estado`. Medido: 244 bytes
 * por asiento contra un tope de 128 KiB por valor de Durable Object, o sea una
 * billetera INESCRIBIBLE a los ~534 movimientos. Ademas reescribia el historial
 * completo en cada operacion, y el mapa de idempotencia crecia para siempre.
 *
 * Ahora el estado vive en el SQLite del propio objeto, que es lo que el plan
 * maestro pedia desde el principio y lo que la ley 5 necesita: el asiento y el
 * evento del outbox se escriben en la MISMA transaccion.
 */
export class BilleteraDO extends DurableObject<Entorno> {
  constructor(ctx: DurableObjectState, env: Entorno) {
    super(ctx, env)
    // El esquema se crea antes de atender nada. `blockConcurrencyWhile` es lo que
    // garantiza que ninguna peticion vea el objeto a medio inicializar — sin el,
    // la primera operacion podria correr contra tablas que todavia no existen.
    // El DDL es idempotente (`IF NOT EXISTS`), asi que corre en cada instancia.
    ctx.blockConcurrencyWhile(async () => {
      for (const sentencia of ESQUEMA) ctx.storage.sql.exec(sentencia)
    })
  }

  private get sql() {
    return this.ctx.storage.sql as unknown as Sql
  }

  /**
   * El camino que recorre toda operacion de plata. Uno solo, a proposito.
   *
   * Cargar → llamar al nucleo → comprobar los invariantes → escribir TODO junto.
   *
   * Los invariantes se comprueban ANTES de persistir: un estado descuadrado no
   * llega al disco, falla la operacion y no la contabilidad. Y la escritura va
   * adentro de `enUnaTransaccion` porque la ley 5 lo pide — si el asiento y el
   * evento se escribieran sueltos, una caida en el medio dejaria plata movida sin
   * el evento que la anuncia, o al reves.
   */
  private aplicar<T>(
    op: { clave_idem: string; correlacion_id: string; momento: string },
    reserva_id: string | undefined,
    operar: (estado: EstadoBilletera) => Resultado<T>,
  ): { valor: T; repetida: boolean } {
    return enUnaTransaccion(this.ctx, () => {
      const estado = cargarEstado(this.sql, this.ctx.id.toString(), op.clave_idem, reserva_id)
      const r = operar(estado)
      if (r.repetida) return { valor: r.valor, repetida: true }

      verificarDelta(r.asientos)
      verificarInvariantes(r.estado)
      guardarDelta(this.sql, r.estado, r.asientos, r.eventos, op.clave_idem, r.valor, op.momento)

      return { valor: r.valor, repetida: false }
    })
  }

  /**
   * `aplicar` mas la reprogramacion de la alarma, que es lo que toda operacion
   * necesita sin excepcion.
   *
   * Existe porque la version anterior dejaba esa segunda mitad a criterio de cada
   * metodo: `reservar` y `liberarReserva` reprogramaban, `acreditar`, `debitar` y
   * `consumirReserva` no. Con la alarma ocupandose solo de los vencimientos eso
   * alcanzaba; desde que tambien dispara al publicador, un `acreditar` que no
   * reprograma es un evento que se queda en el outbox hasta que alguien mas toque
   * esta billetera. Podrian ser meses.
   *
   * Se arregla la categoria: ya no hay dos caminos que puedan divergir, hay uno.
   */
  private async operar<T>(
    op: { clave_idem: string; correlacion_id: string; momento: string },
    reserva_id: string | undefined,
    operar: (estado: EstadoBilletera) => Resultado<T>,
  ): Promise<{ valor: T; repetida: boolean }> {
    const r = this.aplicar(op, reserva_id, operar)
    await this.reprogramarAlarma()
    return r
  }

  async acreditar(op: Operacion, entrada: Parameters<typeof acreditar>[2]) {
    return this.operar(op, undefined, (e) => acreditar(e, op, entrada))
  }

  async debitar(op: Operacion, entrada: Parameters<typeof debitar>[2]) {
    return this.operar(op, undefined, (e) => debitar(e, op, entrada))
  }

  async reservar(op: Operacion, entrada: Parameters<typeof reservar>[2]) {
    return this.operar(op, entrada.reserva_id, (e) => reservar(e, op, entrada))
  }

  async liberarReserva(op: Operacion, entrada: Parameters<typeof liberarReserva>[2]) {
    return this.operar(op, entrada.reserva_id, (e) => liberarReserva(e, op, entrada))
  }

  async consumirReserva(op: Operacion, entrada: Parameters<typeof consumirReserva>[2]) {
    return this.operar(op, entrada.reserva_id, (e) => consumirReserva(e, op, entrada))
  }

  /**
   * Saca del outbox lo que todavia no llego a D1. Ley 5, la mitad que faltaba.
   *
   * POR QUE NO SE PUBLICA ADENTRO DE LA OPERACION
   *
   * Seria una linea menos y esta mal. Escribir en D1 es un `await` a otro sistema,
   * y adentro de un Durable Object un `await` mantiene el input gate cerrado: toda
   * operacion de esa billetera esperaria a la latencia de D1. Peor todavia, no se
   * podria hacer adentro de `enUnaTransaccion` —`transactionSync` no envuelve un
   * `await`, que es justamente por lo que se eligio— asi que tampoco se ganaria
   * atomicidad. Se pagaria la demora sin comprar nada.
   *
   * Se publica desde la alarma, que el objeto programa para "ahora" apenas queda
   * algo pendiente. La copia llega en milisegundos y el que movio la plata no
   * espera a D1.
   *
   * QUE PASA CUANDO D1 NO CONTESTA, dicho entero
   *
   * No se relanza el error. Si `alarm()` tirara, Cloudflare reintentaria con SU
   * backoff y despues de unos intentos dejaria de reintentar: el outbox quedaria
   * pendiente sin nadie que lo despierte. En lugar de eso se cuenta el intento y
   * se deja que `reprogramarAlarma` ponga la proxima pasada, cada vez mas lejos y
   * con techo de cinco minutos. Un outbox atascado reintenta para siempre, que es
   * lo correcto para un evento de plata, y `diagnostico()` lo dice.
   *
   * LO QUE FALTA: no hay cola de descarte. Una fila que no se pueda publicar nunca
   * —un cuerpo malformado por un cambio de codigo, por ejemplo— traba la cabeza de
   * la cola y bloquea a las que vienen atras. Se ve en `intentos` y en el log, no
   * se resuelve solo. Es trabajo de una entrega posterior.
   */
  async publicar(): Promise<{ publicados: number; pendientes: number }> {
    let publicados = 0

    for (let pasada = 0; pasada < PASADAS_MAXIMAS; pasada += 1) {
      const filas = outboxPendiente(this.sql, LOTE)
      if (filas.length === 0) break

      const ids = filas.map((f) => f.id)
      const momento = new Date().toISOString()

      try {
        const lote = sentencias(this.ctx.id.toString(), filas, momento)
        await this.env.CORE.batch(lote.map((s) => this.env.CORE.prepare(s.sql).bind(...s.valores)))
      } catch (e) {
        // El contador va en su propia transaccion: es lo unico que se escribe y
        // tiene que quedar aunque el lote no haya salido.
        enUnaTransaccion(this.ctx, () => contarIntento(this.sql, ids))
        console.error(
          `billetera ${this.ctx.id.toString()}: no se pudo publicar el outbox (${ids.length} filas desde la ${ids[0]})`,
          e,
        )
        break
      }

      enUnaTransaccion(this.ctx, () => marcarPublicadas(this.sql, ids, momento))
      publicados += filas.length
    }

    return { publicados, pendientes: resumenDelOutbox(this.sql).pendientes }
  }

  /** Lo que hace falta para saber si esta billetera esta al dia, sin abrir la
   *  base. El `pendientes` que no baja y el `intentos_maximos` que sube son la
   *  forma que toma un outbox atascado. */
  async diagnostico() {
    return {
      outbox: resumenDelOutbox(this.sql),
      alarma: await this.ctx.storage.getAlarm(),
    }
  }

  /**
   * Deja la alarma apuntando a lo PRIMERO que haya que hacer, o la borra si no hay
   * nada.
   *
   * Hay UNA sola alarma por Durable Object, no una cola: programar la de una
   * reserva pisa la de la anterior. Por eso no se programa "al reservar" sino que
   * se recalcula entera despues de cada operacion, y por eso esta funcion tiene que
   * mirar TODOS los motivos que existen para despertar al objeto. Hoy son dos:
   *
   *   · una reserva que vence — hay que devolver la plata
   *   · una fila del outbox que no llego a D1 — hay que publicarla
   *
   * Gana el mas cercano. Que los dos compartan la alarma es seguro porque `alarm()`
   * hace las dos cosas en cada disparo, sin fijarse cual la programo: si la que
   * manda es la del outbox y hay una reserva vencida, la reserva se libera igual.
   *
   * Lo que eso si cuesta, y queda dicho: mientras D1 no conteste, el reintento del
   * outbox se aleja hasta cinco minutos, y un vencimiento que caiga en el medio
   * puede atenderse hasta cinco minutos tarde. Sobre un plazo de treinta minutos es
   * un error del 16 %, en un caso que ademas requiere que D1 este caida.
   *
   * Va afuera de la transaccion a proposito: `setAlarm` es asincrono y
   * `transactionSync` no puede envolver un `await` — que es justamente la razon
   * por la que se eligio la version sincrona. Si el objeto muriera entre la
   * escritura y esta linea, la reserva queda en la base sin alarma; la red que lo
   * cubre es que toda operacion siguiente sobre este objeto vuelve a
   * reprogramar. No es una garantia fuerte y queda dicho: el barrido de reservas
   * huerfanas es trabajo de una entrega posterior.
   */
  private async reprogramarAlarma(): Promise<void> {
    const ahora = Date.now()
    const { vencidas, proximoVencimiento } = reservasVencidas(this.sql, new Date(ahora).toISOString())
    const cabeza = cabezaDelOutbox(this.sql)

    // La decision de CUANDO vive en `billetera/alarma.ts`, pura y con sus pruebas.
    // Acá quedan las tres cosas que necesitan el objeto: leer el estado, leer el
    // reloj y llamar a la storage. Esa separacion la pidio el arnes de mutacion —
    // con las ramas escritas acá, una de ellas no se podia matar sin ganarle una
    // carrera a la alarma que se dispara sola.
    const cuando = cuandoDespertar({
      ahora,
      hayVencidas: vencidas.length > 0,
      proximoVencimiento,
      intentosDeLaCabeza: cabeza === null ? null : cabeza.intentos,
    })

    if (cuando === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(cuando)
  }

  /**
   * Una reserva sin confirmar vence sola. Sin cron y sin barrido: la alarma del
   * propio objeto, que es lo que el plan maestro pide.
   *
   * Este es el UNICO lugar que decide MOVIMIENTOS DE PLATA leyendo el reloj. En
   * todos los demas el instante entra por parametro, para que el vencimiento se
   * pueda probar sin esperar tres meses. Acá no hay quien lo pase: el que llama es
   * Cloudflare. (`publicar()` y `reprogramarAlarma()` tambien miran la hora, pero
   * para sellar una copia y para programar un despertador: ninguna de las dos
   * decide de quien es un guarani.)
   *
   * QUE IMPIDE QUE UNA SEGUNDA PASADA LIBERE DE NUEVO, con precision:
   *
   * Lo hace el filtro `estado = 'abierta'` de `reservasVencidas`. Despues de la
   * primera pasada la reserva queda `cancelada`, asi que la segunda ni siquiera la
   * ve. Eso esta probado: hay una prueba que corre el handler dos veces y verifica
   * que el saldo y la cantidad de asientos no se mueven.
   *
   * La clave de idempotencia —`vencimiento:<reserva_id>`, derivada y estable— es
   * una SEGUNDA capa, para el caso de dos pasadas que se pisen antes de que la
   * primera escriba. Cloudflare reintenta las alarmas que fallan, asi que entregar
   * doble no es una hipotesis.
   *
   * Y esto ultimo hay que decirlo entero: esa segunda capa NO esta cubierta por
   * ninguna prueba de este arnes. Lo dijo la mutacion —cambiar la clave por una
   * aleatoria SOBREVIVIO, porque el filtro de estado ya alcanza para el caso que
   * las pruebas ejercitan—. La mutacion se saco en vez de dejarla mintiendo, y
   * queda escrito acá que la garantia probada es una sola.
   */
  override async alarm(): Promise<void> {
    const momento = new Date().toISOString()
    const { vencidas } = reservasVencidas(this.sql, momento)

    for (const reserva_id of vencidas) {
      const op = {
        clave_idem: `vencimiento:${reserva_id}`,
        correlacion_id: `vencimiento:${reserva_id}`,
        momento,
      }
      this.aplicar(op, reserva_id, (e) => liberarReserva(e, op, { reserva_id }))
    }

    // Publicar va DESPUES de liberar, no antes: liberar produce eventos, y si se
    // publicara primero esos eventos esperarian a la proxima vuelta de la alarma.
    await this.publicar()

    await this.reprogramarAlarma()
  }

  /** Lo que hay, para consulta. No toca nada. */
  async saldo() {
    const estado = cargarEstado(this.sql, this.ctx.id.toString(), '')
    const asientos = [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')][0]
    return { bolsas: estado.bolsas, asientos: asientos?.n ?? 0 }
  }

  /**
   * La reconciliacion exhaustiva. No corre en el camino caliente a proposito:
   * recorre la tabla de asientos entera.
   *
   * `verificarInvariantes` compara las bolsas contra `totales_ledger`, que es un
   * cache mantenido en la misma transaccion que los asientos. Esto es lo unico
   * que puede notar que ese cache se corrompio por su cuenta.
   */
  async reconciliar() {
    return reconciliar(this.sql)
  }
}

/**
 * Un contador monotono necesita un solo escritor. Uno por ano.
 * Formato: RY-2026-000001.
 */
export class SecuenciaDO extends DurableObject<Entorno> {
  async siguiente(anio: number): Promise<string> {
    const clave = `n:${anio}`
    const actual = (await this.ctx.storage.get<number>(clave)) ?? 0
    const proximo = actual + 1
    await this.ctx.storage.put(clave, proximo)
    return `RY-${anio}-${String(proximo).padStart(6, '0')}`
  }
}

export default {
  async fetch(peticion: Request, entorno: Entorno): Promise<Response> {
    const url = new URL(peticion.url)

    // Comprobacion de vida. Sirve para que el despliegue a staging tenga algo
    // que verificar automaticamente y no dependa de que alguien mire.
    if (url.pathname === '/salud') {
      return Response.json({
        estado: 'vivo',
        entorno: entorno.ENTORNO,
        zona_horaria: entorno.ZONA_HORARIA,
        // El guarani se valida hasta en el healthcheck: si el tipo se rompiera,
        // esto explota en el despliegue y no tres meses despues.
        moneda: { codigo: 'PYG', decimales: 0, ejemplo: guaranies(100_000) },
      })
    }

    return new Response('no encontrado', { status: 404 })
  },
}
