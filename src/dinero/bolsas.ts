/**
 * Bolsas del saldo, y la precedencia de consumo.
 *
 * El saldo NO es un numero: es un conjunto de bolsas distinguibles con reglas
 * distintas. Modelarlo como un entero unico es la decision que despues obliga
 * a reescribir el nucleo entero.
 *
 * Ley 4: "que se consume en este instante" es una FUNCION PURA, con
 * precedencia declarada y probada contra casos superpuestos. Nunca un ORDER BY.
 *
 * Ley 11: la plata regalada nunca se convierte en plata retirable.
 */

import { type Guaranies, guaranies, CERO } from './monto.js'

export type TipoBolsa = 'disponible' | 'ganancia_creador' | 'credito_promocion' | 'retenido'

export interface Bolsa {
  readonly tipo: TipoBolsa
  readonly monto: Guaranies
  /** ISO-8601 UTC. `null` = no vence. */
  readonly vence_en: string | null
  /** De donde salio. Al devolver, vuelve a la bolsa de la que salio. */
  readonly origen: string
  /** Si esta restringida, solo sirve para lo que dice. */
  readonly restringida_a: string | null
}

export interface Toma {
  readonly bolsa: Bolsa
  readonly monto: Guaranies
}

export interface ResultadoConsumo {
  readonly tomas: readonly Toma[]
  /** Lo que las bolsas no alcanzaron a cubrir. Va a la pasarela. */
  readonly faltante: Guaranies
}

/**
 * Precedencia declarada. El orden NO es negociable y no se deriva de los datos:
 *
 *   1. credito_promocion  — el mas restringido y el que vence. Va primero
 *                           siempre: es un descuento, y protege al creador de
 *                           perderlo por vencimiento.
 *   2. ganancia_creador   — plata suya, pero con ventana de retencion.
 *   3. disponible         — lo ultimo, para que conserve liquidez retirable.
 *
 * Dentro de un mismo tipo, primero lo que vence antes. A igual vencimiento,
 * el origen alfabetico — desempate arbitrario pero ESTABLE, que es lo que
 * hace la funcion reproducible y por lo tanto probable.
 *
 * `retenido` NO esta en esta lista a proposito: es plata de una reserva
 * abierta, ya afectada a otra cosa. No se gasta — `decidirConsumo` la saca
 * del juego antes de llegar aca. Si algun dia entra a esta lista por
 * accidente, `rango()` la va a dejar en el ULTIMO lugar de precedencia, no
 * fuera de circulacion, que es un defecto distinto y peor.
 */
const PRECEDENCIA: readonly TipoBolsa[] = ['credito_promocion', 'ganancia_creador', 'disponible']

function rango(t: TipoBolsa): number {
  const i = PRECEDENCIA.indexOf(t)
  // Un tipo nuevo que nadie agrego a la precedencia no puede quedar primero
  // por accidente. Que falle ruidosamente es la unica opcion aceptable.
  if (i < 0) throw new Error(`bolsa sin precedencia declarada: ${t}`)
  return i
}

export function ordenarPorPrecedencia(bolsas: readonly Bolsa[]): Bolsa[] {
  return [...bolsas].sort((a, b) => {
    const r = rango(a.tipo) - rango(b.tipo)
    if (r !== 0) return r

    // Lo que vence antes, primero. Lo que no vence, al final de su tipo.
    const va = a.vence_en ?? '9999-12-31T23:59:59Z'
    const vb = b.vence_en ?? '9999-12-31T23:59:59Z'
    if (va !== vb) return va < vb ? -1 : 1

    return a.origen < b.origen ? -1 : a.origen > b.origen ? 1 : 0
  })
}

/**
 * Decide, para un monto y un instante dados, de que bolsas sale la plata.
 *
 * Funcion pura: no lee reloj, no toca base, no muta la entrada. El `momento`
 * entra por parametro justamente para que el vencimiento sea probable sin
 * esperar tres meses.
 *
 * `omitirDisponible` es la opcion del creador de no gastar su plata liquida.
 * Si la pide, el faltante crece y lo cubre la pasarela.
 */
export function decidirConsumo(
  bolsas: readonly Bolsa[],
  requerido: Guaranies,
  momento: string,
  opciones: { readonly omitirDisponible?: boolean; readonly proposito?: string } = {},
): ResultadoConsumo {
  if (requerido < 0) throw new Error('no se consume un monto negativo')

  const tomas: Toma[] = []
  let restante: number = requerido

  // `retenido` es la plata de una reserva abierta: ya salio de circulacion y
  // solo puede volver por `liberarReserva()`. Se filtra ACA, antes de ordenar,
  // en vez de confiar en que `rango()` la mande al final de la precedencia —
  // eso seria un accidente de implementacion, no una regla declarada. Sin
  // este filtro, una segunda reserva podria volver a tomar plata que la
  // primera ya tiene retenida.
  const disponiblesParaConsumo = bolsas.filter((b) => b.tipo !== 'retenido')

  for (const bolsa of ordenarPorPrecedencia(disponiblesParaConsumo)) {
    if (restante <= 0) break
    if (bolsa.monto <= 0) continue

    // Vencida: no se toca. Se compara contra el momento que nos pasaron.
    if (bolsa.vence_en !== null && bolsa.vence_en <= momento) continue

    // Restringida a otra cosa: no sirve para este proposito.
    if (bolsa.restringida_a !== null && bolsa.restringida_a !== opciones.proposito) continue

    if (bolsa.tipo === 'disponible' && opciones.omitirDisponible === true) continue

    const toma = Math.min(restante, bolsa.monto)
    tomas.push({ bolsa, monto: guaranies(toma) })
    restante -= toma
  }

  return { tomas, faltante: guaranies(restante) }
}

/**
 * La regla anticajero (ley 11).
 *
 * Al cancelar una campana, cada parte vuelve a la bolsa DE LA QUE SALIO: el
 * credito como credito, con su vencimiento ORIGINAL; la plata como plata.
 *
 * Sin esto, "crear campana y cancelarla" es la maquina de convertir premios en
 * efectivo retirable. Es la razon por la que las tomas guardan la bolsa entera
 * y no solo su monto.
 */
export function devolver(tomas: readonly Toma[], aDevolver: Guaranies): Bolsa[] {
  if (aDevolver < 0) throw new Error('no se devuelve un monto negativo')

  const consumido = tomas.reduce((a, t) => a + t.monto, 0)
  if (aDevolver > consumido) {
    throw new Error(`no se puede devolver ${aDevolver} de un consumo de ${consumido}`)
  }

  // Se devuelve en orden INVERSO al consumo: lo ultimo que se gasto es lo
  // primero que vuelve. Asi el credito que vence pronto queda gastado y no
  // se le devuelve al usuario un credito a punto de morir.
  const devueltas: Bolsa[] = []
  let restante: number = aDevolver

  for (let i = tomas.length - 1; i >= 0 && restante > 0; i--) {
    const t = tomas[i]
    if (t === undefined) continue
    const monto = Math.min(restante, t.monto)
    devueltas.push({ ...t.bolsa, monto: guaranies(monto) })
    restante -= monto
  }

  return devueltas
}

export function saldoPorTipo(bolsas: readonly Bolsa[], tipo: TipoBolsa, momento: string): Guaranies {
  const total = bolsas
    .filter((b) => b.tipo === tipo)
    .filter((b) => b.vence_en === null || b.vence_en > momento)
    .reduce((a, b) => a + b.monto, 0)
  return total === 0 ? CERO : guaranies(total)
}

/** Lo unico que se puede retirar. El credito de promocion NUNCA entra acá. */
export function saldoRetirable(bolsas: readonly Bolsa[], momento: string): Guaranies {
  return saldoPorTipo(bolsas, 'disponible', momento)
}
