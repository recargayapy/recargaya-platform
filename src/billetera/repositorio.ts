/**
 * La traduccion entre el SQLite del Durable Object y el estado que el nucleo usa.
 *
 * Existe para que `nucleo.ts` siga siendo puro. El nucleo no sabe que hay una
 * base: recibe un estado, devuelve un estado nuevo y un delta. Este archivo es el
 * unico que sabe de tablas, y el Durable Object es el unico que sabe de las dos
 * cosas a la vez.
 *
 * ---------------------------------------------------------------------------
 * POR QUE SE CARGA UN ESTADO ANGOSTO Y NO TODO
 *
 * La version anterior guardaba el estado entero como un JSON en una clave. Medido:
 * 244 bytes por asiento contra un tope de 128 KiB por valor, o sea una billetera
 * INESCRIBIBLE a los ~534 movimientos, y la reescritura del historial completo en
 * cada operacion.
 *
 * Ahora se carga lo que el nucleo realmente mira, y nada mas:
 *
 *   · las bolsas — son pocas por definicion: una bolsa se borra al llegar a cero
 *   · los totales del ledger — cuatro filas, una por tipo de bolsa
 *   · las reservas ABIERTAS, mas la que la operacion nombre
 *   · el resultado previo de ESTA clave de idempotencia, si existe
 *
 * Los asientos NO se cargan nunca. Son append-only y el nucleo no los lee: los
 * produce. Esa es toda la razon por la que el estado pudo angostarse.
 */

import {
  type Asiento,
  type Evento,
  type EstadoBilletera,
  type Reserva,
} from './nucleo.js'
import { type Bolsa, type TipoBolsa, type Toma } from '../dinero/bolsas.js'
import { guaranies } from '../dinero/monto.js'

/** Lo minimo que este archivo necesita del SQLite del Durable Object. */
export interface Sql {
  exec<T = Record<string, unknown>>(consulta: string, ...valores: unknown[]): Iterable<T>
}

interface FilaBolsa {
  tipo: TipoBolsa
  monto: number
  vence_en: string | null
  origen: string
  restringida_a: string | null
}

function aBolsa(f: FilaBolsa): Bolsa {
  return {
    tipo: f.tipo,
    monto: guaranies(f.monto),
    vence_en: f.vence_en,
    origen: f.origen,
    restringida_a: f.restringida_a,
  }
}

/**
 * Arma el `aplicadas` del estado con UNA sola clave: la de esta operacion.
 *
 * El nucleo solo hace `estado.aplicadas.get(op.clave_idem)` y nada mas — no
 * recorre el mapa ni busca otras claves. Cargar la tabla entera seria traer un
 * historial que crece para siempre para leer un solo renglon.
 *
 * Esa afirmacion sobre el nucleo no es una suposicion de este comentario: hay una
 * prueba que le pasa un mapa con una clave señuelo y verifica que el resultado no
 * cambia. Si alguien hiciera que el nucleo mirara otra clave, esa prueba muere.
 */
export function soloLaClaveDeLaOperacion(
  sql: Sql,
  clave_idem: string,
): ReadonlyMap<string, string> {
  const filas = [...sql.exec<{ valor: string }>(
    'SELECT valor FROM aplicadas WHERE clave_idem = ?',
    clave_idem,
  )]
  const m = new Map<string, string>()
  const fila = filas[0]
  if (fila !== undefined) m.set(clave_idem, fila.valor)
  return m
}

/**
 * Las reservas que el nucleo necesita ver: todas las ABIERTAS —el invariante de
 * `retenido` las suma— mas la que la operacion nombre, que puede estar cerrada.
 *
 * Sin la segunda, `liberarReserva` no podria distinguir «no existe» de «ya se
 * libero», y esas dos cosas tienen que dar resultados distintos.
 */
export function cargarReservas(sql: Sql, reserva_id?: string): ReadonlyMap<string, Reserva> {
  const filas = [
    ...sql.exec<{ reserva_id: string; consumido: number; vence_en: string; estado: string }>(
      reserva_id === undefined
        ? "SELECT reserva_id, consumido, vence_en, estado FROM reservas WHERE estado = 'abierta'"
        : "SELECT reserva_id, consumido, vence_en, estado FROM reservas WHERE estado = 'abierta' OR reserva_id = ?",
      ...(reserva_id === undefined ? [] : [reserva_id]),
    ),
  ]

  const m = new Map<string, Reserva>()
  for (const f of filas) {
    const tomas = [
      ...sql.exec<FilaBolsa & { monto: number }>(
        'SELECT tipo, monto, vence_en, origen, restringida_a FROM tomas WHERE reserva_id = ? ORDER BY orden',
        f.reserva_id,
      ),
    ].map((t): Toma => ({ bolsa: aBolsa(t), monto: guaranies(t.monto) }))

    m.set(f.reserva_id, {
      reserva_id: f.reserva_id,
      tomas,
      consumido: guaranies(f.consumido),
      vence_en: f.vence_en,
      estado: f.estado as Reserva['estado'],
    })
  }
  return m
}

/** El estado angosto que el nucleo va a recibir. */
export function cargarEstado(
  sql: Sql,
  billetera_id: string,
  clave_idem: string,
  reserva_id?: string,
): EstadoBilletera {
  const bolsas = [
    ...sql.exec<FilaBolsa>(
      'SELECT tipo, monto, vence_en, origen, restringida_a FROM bolsas ORDER BY id',
    ),
  ].map(aBolsa)

  const totales = new Map<TipoBolsa, number>()
  for (const f of sql.exec<{ bolsa: TipoBolsa; total: number }>(
    'SELECT bolsa, total FROM totales_ledger',
  )) {
    totales.set(f.bolsa, f.total)
  }

  return {
    billetera_id,
    bolsas,
    totales,
    reservas: cargarReservas(sql, reserva_id),
    aplicadas: soloLaClaveDeLaOperacion(sql, clave_idem),
  }
}

/**
 * Escribe el resultado de una operacion. TODO junto o nada.
 *
 * Quien llama es responsable de envolver esto en `enUnaTransaccion`: la ley 5
 * pide que el evento del outbox se escriba en la misma transaccion que el cambio,
 * y esa garantia se pierde si esta funcion se llama suelta. Esta escrito asi
 * —y no abriendo la transaccion acá adentro— para que el Durable Object pueda
 * meter varias escrituras en una sola, y porque una funcion que abre su propia
 * transaccion no compone.
 *
 * Las bolsas se borran y se reinsertan enteras en vez de calcular un diff. Son
 * pocas por definicion —una bolsa desaparece al llegar a cero— y un diff seria
 * codigo con estados intermedios a cambio de nada.
 */
export function guardarDelta(
  sql: Sql,
  estado: EstadoBilletera,
  asientos: readonly Asiento[],
  eventos: readonly Evento[],
  clave_idem: string,
  valor: unknown,
  momento: string,
): void {
  sql.exec('DELETE FROM bolsas')
  for (const b of estado.bolsas) {
    sql.exec(
      'INSERT INTO bolsas (tipo, monto, vence_en, origen, restringida_a) VALUES (?, ?, ?, ?, ?)',
      b.tipo,
      b.monto,
      b.vence_en,
      b.origen,
      b.restringida_a,
    )
  }

  for (const [bolsa, total] of estado.totales) {
    sql.exec(
      'INSERT INTO totales_ledger (bolsa, total) VALUES (?, ?) ON CONFLICT (bolsa) DO UPDATE SET total = excluded.total',
      bolsa,
      total,
    )
  }

  for (const r of estado.reservas.values()) {
    sql.exec(
      'INSERT INTO reservas (reserva_id, consumido, vence_en, estado) VALUES (?, ?, ?, ?) ON CONFLICT (reserva_id) DO UPDATE SET consumido = excluded.consumido, estado = excluded.estado',
      r.reserva_id,
      r.consumido,
      r.vence_en,
      r.estado,
    )
    // Las tomas se escriben una sola vez, al nacer la reserva: describen de que
    // bolsa salio cada parte y eso no cambia nunca. `INSERT OR IGNORE` las deja
    // pasar de largo en las operaciones siguientes sin un SELECT previo.
    r.tomas.forEach((t, orden) => {
      sql.exec(
        'INSERT OR IGNORE INTO tomas (reserva_id, orden, tipo, monto, vence_en, origen, restringida_a) VALUES (?, ?, ?, ?, ?, ?, ?)',
        r.reserva_id,
        orden,
        t.bolsa.tipo,
        t.monto,
        t.bolsa.vence_en,
        t.bolsa.origen,
        t.bolsa.restringida_a,
      )
    })
  }

  for (const a of asientos) {
    sql.exec(
      'INSERT INTO asientos (asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en) VALUES (?, ?, ?, ?, ?, ?, ?)',
      a.asiento_id,
      a.concepto,
      a.monto,
      a.bolsa,
      a.clave_idem,
      a.correlacion_id,
      a.asentado_en,
    )
  }

  // Ley 5. Va acá adentro, con todo lo demas, y no en una escritura aparte.
  for (const e of eventos) {
    sql.exec(
      'INSERT INTO outbox (tipo, cuerpo, correlacion_id, creado_en) VALUES (?, ?, ?, ?)',
      e.tipo,
      e.cuerpo,
      e.correlacion_id,
      e.creado_en,
    )
  }

  sql.exec(
    'INSERT INTO aplicadas (clave_idem, valor, aplicada_en) VALUES (?, ?, ?)',
    clave_idem,
    JSON.stringify(valor),
    momento,
  )
}

/**
 * La reconciliacion exhaustiva: suma los asientos de verdad y los compara contra
 * `totales_ledger`.
 *
 * `verificarInvariantes` compara las bolsas contra ese acumulado, que es un
 * cache. Este es el unico lugar que puede notar que el cache se corrompio por su
 * cuenta, y por eso no vive en el camino caliente: recorre la tabla entera.
 */
export function reconciliar(sql: Sql): { ok: boolean; diferencias: string[] } {
  const sumado = new Map<string, number>()
  for (const f of sql.exec<{ bolsa: string; total: number }>(
    'SELECT bolsa, SUM(monto) AS total FROM asientos GROUP BY bolsa',
  )) {
    sumado.set(f.bolsa, f.total)
  }

  const cache = new Map<string, number>()
  for (const f of sql.exec<{ bolsa: string; total: number }>(
    'SELECT bolsa, total FROM totales_ledger',
  )) {
    cache.set(f.bolsa, f.total)
  }

  const diferencias: string[] = []
  for (const bolsa of new Set([...sumado.keys(), ...cache.keys()])) {
    const a = sumado.get(bolsa) ?? 0
    const b = cache.get(bolsa) ?? 0
    if (a !== b) diferencias.push(`${bolsa}: asientos ${a} vs totales_ledger ${b}`)
  }

  return { ok: diferencias.length === 0, diferencias }
}

/**
 * Las reservas abiertas que ya vencieron, y el proximo vencimiento pendiente.
 *
 * Las dos cosas en una consulta sola porque el `alarm()` necesita las dos: libera
 * las vencidas y se reprograma para la siguiente. Si fueran dos consultas, entre
 * una y otra podria entrar una reserva nueva y quedar sin alarma.
 */
export function reservasVencidas(sql: Sql, momento: string): {
  vencidas: string[]
  proximoVencimiento: string | null
} {
  const abiertas = [
    ...sql.exec<{ reserva_id: string; vence_en: string }>(
      "SELECT reserva_id, vence_en FROM reservas WHERE estado = 'abierta' ORDER BY vence_en",
    ),
  ]

  const vencidas = abiertas.filter((r) => r.vence_en <= momento).map((r) => r.reserva_id)
  const pendiente = abiertas.find((r) => r.vence_en > momento)

  return { vencidas, proximoVencimiento: pendiente?.vence_en ?? null }
}
