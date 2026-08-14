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
  billeteraVacia,
  acreditar,
  debitar,
  verificarInvariantes,
} from './billetera/nucleo.js'
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
 * Es una cascara delgada a proposito: persiste y delega. La logica vive en
 * `billetera/nucleo.ts`, que es puro y por lo tanto probable sin runtime.
 * Si la logica viviera aca, la mutacion seria impracticable.
 */
export class BilleteraDO extends DurableObject<Entorno> {
  private estado: EstadoBilletera | null = null

  private async cargar(): Promise<EstadoBilletera> {
    if (this.estado !== null) return this.estado
    const guardado = await this.ctx.storage.get<string>('estado')
    this.estado =
      guardado === undefined
        ? billeteraVacia(this.ctx.id.toString())
        : (rehidratar(guardado))
    return this.estado
  }

  private async guardar(nuevo: EstadoBilletera): Promise<void> {
    // El invariante se comprueba ANTES de persistir. Un estado descuadrado no
    // llega al disco: falla la operacion, no la contabilidad.
    verificarInvariantes(nuevo)
    this.estado = nuevo
    await this.ctx.storage.put('estado', deshidratar(nuevo))
  }

  async acreditar(op: Parameters<typeof acreditar>[1], entrada: Parameters<typeof acreditar>[2]) {
    const r = acreditar(await this.cargar(), op, entrada)
    if (!r.repetida) await this.guardar(r.estado)
    return { valor: r.valor, repetida: r.repetida }
  }

  async debitar(op: Parameters<typeof debitar>[1], entrada: Parameters<typeof debitar>[2]) {
    const r = debitar(await this.cargar(), op, entrada)
    if (!r.repetida) await this.guardar(r.estado)
    return { valor: r.valor, repetida: r.repetida }
  }

  async saldo() {
    const e = await this.cargar()
    return { bolsas: e.bolsas, asientos: e.asientos.length }
  }
}

function deshidratar(e: EstadoBilletera): string {
  return JSON.stringify({
    billetera_id: e.billetera_id,
    bolsas: e.bolsas,
    asientos: e.asientos,
    reservas: [...e.reservas.entries()],
    aplicadas: [...e.aplicadas.entries()],
  })
}

function rehidratar(s: string): EstadoBilletera {
  const d = JSON.parse(s) as {
    billetera_id: string
    bolsas: EstadoBilletera['bolsas']
    asientos: EstadoBilletera['asientos']
    reservas: [string, never][]
    aplicadas: [string, string][]
  }
  return {
    billetera_id: d.billetera_id,
    bolsas: d.bolsas,
    asientos: d.asientos,
    reservas: new Map(d.reservas),
    aplicadas: new Map(d.aplicadas),
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
