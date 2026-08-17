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
  verificarInvariantes,
  verificarDelta,
} from './billetera/nucleo.js'
import { ESQUEMA } from './billetera/esquema.js'
import { enUnaTransaccion } from './billetera/transaccion.js'
import { type Sql, cargarEstado, guardarDelta, reconciliar } from './billetera/repositorio.js'
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

  async acreditar(op: Operacion, entrada: Parameters<typeof acreditar>[2]) {
    return this.aplicar(op, undefined, (e) => acreditar(e, op, entrada))
  }

  async debitar(op: Operacion, entrada: Parameters<typeof debitar>[2]) {
    return this.aplicar(op, undefined, (e) => debitar(e, op, entrada))
  }

  async reservar(op: Operacion, entrada: Parameters<typeof reservar>[2]) {
    return this.aplicar(op, entrada.reserva_id, (e) => reservar(e, op, entrada))
  }

  async liberarReserva(op: Operacion, entrada: Parameters<typeof liberarReserva>[2]) {
    return this.aplicar(op, entrada.reserva_id, (e) => liberarReserva(e, op, entrada))
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
