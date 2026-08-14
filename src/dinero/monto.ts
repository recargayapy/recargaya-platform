/**
 * Guaranies. Enteros, siempre.
 *
 * No existe el centimo de guarani. Un `number` con decimales entrando al
 * dominio del dinero es un defecto silencioso: no rompe nada hoy y descuadra
 * el ledger en tres meses.
 *
 * El tipo `Guaranies` es nominal — un `number` cualquiera no se le asigna sin
 * pasar por `guaranies()`, que valida. El compilador se vuelve el primer
 * oraculo, gratis y antes de correr una sola prueba.
 */

declare const marcaGuaranies: unique symbol

export type Guaranies = number & { readonly [marcaGuaranies]: true }

export class MontoInvalido extends Error {
  constructor(valor: number, motivo: string) {
    super(`monto invalido (${valor}): ${motivo}`)
    this.name = 'MontoInvalido'
  }
}

/** Unica puerta de entrada al tipo. Todo lo demas confia en que esto valido. */
export function guaranies(valor: number): Guaranies {
  if (!Number.isFinite(valor)) throw new MontoInvalido(valor, 'no es un numero finito')
  if (!Number.isInteger(valor)) throw new MontoInvalido(valor, 'el guarani no tiene decimales')
  if (!Number.isSafeInteger(valor)) throw new MontoInvalido(valor, 'fuera del entero seguro')
  return valor as Guaranies
}

export const CERO: Guaranies = guaranies(0)

export function sumar(a: Guaranies, b: Guaranies): Guaranies {
  return guaranies(a + b)
}

export function restar(a: Guaranies, b: Guaranies): Guaranies {
  return guaranies(a - b)
}

export function esPositivo(m: Guaranies): boolean {
  return m > 0
}

/**
 * Reparte un monto en partes proporcionales SIN perder ni inventar un guarani.
 *
 * Este es el defecto clasico del reparto: tres porcentajes que suman 100 y una
 * division entera que pierde 1 o 2 guaranies por operacion. A escala eso es un
 * descuadre permanente del ledger que nadie encuentra porque es chico.
 *
 * La solucion es el metodo del resto mayor: se trunca todo, y el remanente se
 * reparte de a un guarani entre las partes con mayor resto, en orden estable.
 *
 * @param total  monto a repartir
 * @param pesos  enteros que representan la proporcion de cada parte
 * @returns      un arreglo del mismo largo que `pesos`, cuya suma es EXACTA
 */
export function repartirExacto(total: Guaranies, pesos: readonly number[]): Guaranies[] {
  if (pesos.length === 0) throw new MontoInvalido(total, 'no hay partes en las que repartir')
  if (pesos.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new MontoInvalido(total, 'los pesos deben ser enteros no negativos')
  }

  const sumaPesos = pesos.reduce((a, b) => a + b, 0)
  if (sumaPesos === 0) throw new MontoInvalido(total, 'los pesos suman cero')

  const truncados = pesos.map((p) => Math.trunc((total * p) / sumaPesos))
  const asignado = truncados.reduce((a, b) => a + b, 0)
  let remanente = total - asignado

  // Orden estable: mayor resto primero; a igual resto, el indice menor.
  // Sin el desempate por indice, el reparto no es reproducible y una prueba
  // pasa o falla segun el humor del motor de JavaScript.
  const porResto = pesos
    .map((p, i) => ({ i, resto: (total * p) % sumaPesos }))
    .sort((a, b) => (b.resto - a.resto) || (a.i - b.i))

  for (const { i } of porResto) {
    if (remanente <= 0) break
    truncados[i] = (truncados[i] ?? 0) + 1
    remanente -= 1
  }

  return truncados.map(guaranies)
}
