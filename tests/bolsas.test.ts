/**
 * La ley 4 y la ley 11, probadas contra casos superpuestos.
 *
 * El plan maestro dice: "funcion pura con precedencia declarada y probada
 * contra casos SUPERPUESTOS. Nunca un ORDER BY". La palabra que importa es
 * superpuestos: el defecto no aparece cuando hay una bolsa, aparece cuando hay
 * tres que compiten y dos vencen el mismo dia.
 */

import { describe, it, expect } from 'vitest'
import { guaranies } from '../src/dinero/monto.js'
import { type Bolsa, decidirConsumo, devolver, ordenarPorPrecedencia, saldoRetirable } from '../src/dinero/bolsas.js'

const AHORA = '2026-08-14T12:00:00Z'

function bolsa(p: Partial<Bolsa> & Pick<Bolsa, 'tipo' | 'monto'>): Bolsa {
  return { vence_en: null, origen: 'x', restringida_a: null, ...p }
}

describe('precedencia de consumo', () => {
  it('el credito de promocion se gasta primero, aunque haya saldo disponible', () => {
    const bolsas = [
      bolsa({ tipo: 'disponible', monto: guaranies(100_000) }),
      bolsa({ tipo: 'credito_promocion', monto: guaranies(30_000), vence_en: '2026-12-31T00:00:00Z' }),
    ]
    const r = decidirConsumo(bolsas, guaranies(50_000), AHORA)

    expect(r.tomas[0]?.bolsa.tipo).toBe('credito_promocion')
    expect(r.tomas[0]?.monto).toBe(30_000)
    expect(r.tomas[1]?.bolsa.tipo).toBe('disponible')
    expect(r.tomas[1]?.monto).toBe(20_000)
    expect(r.faltante).toBe(0)
  })

  it('entre dos creditos, primero el que vence antes', () => {
    const bolsas = [
      bolsa({ tipo: 'credito_promocion', monto: guaranies(10_000), vence_en: '2026-12-31T00:00:00Z', origen: 'tarde' }),
      bolsa({ tipo: 'credito_promocion', monto: guaranies(10_000), vence_en: '2026-09-01T00:00:00Z', origen: 'temprano' }),
    ]
    const r = decidirConsumo(bolsas, guaranies(10_000), AHORA)
    expect(r.tomas[0]?.bolsa.origen).toBe('temprano')
  })

  it('a igual vencimiento el orden es estable, no depende del motor', () => {
    const mismas: Bolsa[] = [
      bolsa({ tipo: 'credito_promocion', monto: guaranies(1), vence_en: '2026-09-01T00:00:00Z', origen: 'zeta' }),
      bolsa({ tipo: 'credito_promocion', monto: guaranies(1), vence_en: '2026-09-01T00:00:00Z', origen: 'alfa' }),
    ]
    // Mismo resultado en las dos direcciones de entrada: eso es estabilidad.
    expect(ordenarPorPrecedencia(mismas)[0]?.origen).toBe('alfa')
    expect(ordenarPorPrecedencia([...mismas].reverse())[0]?.origen).toBe('alfa')
  })

  it('una bolsa vencida no se toca, y el faltante lo refleja', () => {
    const bolsas = [
      bolsa({ tipo: 'credito_promocion', monto: guaranies(50_000), vence_en: '2026-01-01T00:00:00Z' }),
    ]
    const r = decidirConsumo(bolsas, guaranies(50_000), AHORA)
    expect(r.tomas).toHaveLength(0)
    expect(r.faltante).toBe(50_000) // va a la pasarela, no se regala
  })

  it('el credito restringido no sirve para otro proposito', () => {
    const bolsas = [
      bolsa({ tipo: 'credito_promocion', monto: guaranies(50_000), vence_en: '2026-12-31T00:00:00Z', restringida_a: 'espacios' }),
    ]
    expect(decidirConsumo(bolsas, guaranies(10_000), AHORA, { proposito: 'recarga' }).faltante).toBe(10_000)
    expect(decidirConsumo(bolsas, guaranies(10_000), AHORA, { proposito: 'espacios' }).faltante).toBe(0)
  })

  it('el creador puede pedir no gastar su plata liquida', () => {
    const bolsas = [
      bolsa({ tipo: 'disponible', monto: guaranies(100_000) }),
      bolsa({ tipo: 'credito_promocion', monto: guaranies(30_000), vence_en: '2026-12-31T00:00:00Z' }),
    ]
    const r = decidirConsumo(bolsas, guaranies(50_000), AHORA, { omitirDisponible: true })
    expect(r.tomas).toHaveLength(1)
    expect(r.faltante).toBe(20_000) // el resto lo cubre la tarjeta
  })

  it('retenido no se consume: esa plata ya esta afectada a una reserva abierta', () => {
    const bolsas = [
      bolsa({ tipo: 'retenido', monto: guaranies(50_000), origen: 'r1' }),
      bolsa({ tipo: 'disponible', monto: guaranies(10_000) }),
    ]
    const r = decidirConsumo(bolsas, guaranies(20_000), AHORA)

    // Alcanzaria de sobra si retenido se pudiera tocar; el faltante prueba
    // que decidirConsumo ni lo mira.
    expect(r.tomas).toHaveLength(1)
    expect(r.tomas[0]?.bolsa.tipo).toBe('disponible')
    expect(r.tomas[0]?.monto).toBe(10_000)
    expect(r.faltante).toBe(10_000)
  })
})

describe('la regla anticajero (ley 11)', () => {
  it('el credito vuelve como credito, con su vencimiento original', () => {
    const bolsas = [
      bolsa({ tipo: 'credito_promocion', monto: guaranies(30_000), vence_en: '2026-09-30T00:00:00Z', origen: 'premio-julio' }),
      bolsa({ tipo: 'disponible', monto: guaranies(100_000) }),
    ]
    const consumo = decidirConsumo(bolsas, guaranies(50_000), AHORA)
    const vueltas = devolver(consumo.tomas, guaranies(50_000))

    const credito = vueltas.find((b) => b.tipo === 'credito_promocion')
    expect(credito?.monto).toBe(30_000)
    expect(credito?.vence_en).toBe('2026-09-30T00:00:00Z') // NO se renueva
    expect(vueltas.find((b) => b.tipo === 'disponible')?.monto).toBe(20_000)
  })

  it('crear campana y cancelarla NO convierte premio en plata retirable', () => {
    // Este es el ataque completo, escrito como prueba.
    const bolsas = [
      bolsa({ tipo: 'credito_promocion', monto: guaranies(200_000), vence_en: '2026-09-30T00:00:00Z' }),
    ]
    const retirableAntes = saldoRetirable(bolsas, AHORA)

    const consumo = decidirConsumo(bolsas, guaranies(200_000), AHORA)
    const vueltas = devolver(consumo.tomas, guaranies(200_000))

    expect(saldoRetirable(vueltas, AHORA)).toBe(retirableAntes) // cero, y sigue cero
    expect(vueltas.every((b) => b.tipo === 'credito_promocion')).toBe(true)
  })

  it('la devolucion parcial vuelve en orden inverso al consumo', () => {
    const bolsas = [
      bolsa({ tipo: 'credito_promocion', monto: guaranies(30_000), vence_en: '2026-09-30T00:00:00Z' }),
      bolsa({ tipo: 'disponible', monto: guaranies(100_000) }),
    ]
    const consumo = decidirConsumo(bolsas, guaranies(50_000), AHORA)
    // Se consumieron 30.000 de credito y 20.000 de plata. Devolvemos 20.000:
    // tiene que volver la PLATA, no el credito — el credito ya se gasto y
    // devolverselo seria darle un credito a punto de vencer.
    const vueltas = devolver(consumo.tomas, guaranies(20_000))
    expect(vueltas).toHaveLength(1)
    expect(vueltas[0]?.tipo).toBe('disponible')
  })

  it('no se puede devolver mas de lo que se consumio', () => {
    const bolsas = [bolsa({ tipo: 'disponible', monto: guaranies(10_000) })]
    const consumo = decidirConsumo(bolsas, guaranies(10_000), AHORA)
    expect(() => devolver(consumo.tomas, guaranies(11_000))).toThrow()
  })
})
