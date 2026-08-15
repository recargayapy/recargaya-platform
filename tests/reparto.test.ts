/**
 * El spike financiero. La prueba que decide si la arquitectura sirve.
 *
 * Criterio de hecho de la Fase 0, textual del plan maestro:
 * "el spike sobrevive a una caida en cada paso".
 */

import { describe, it, expect } from 'vitest'
import { guaranies } from '../src/dinero/monto.js'
import { type Venta, type PesosReparto, planificar, calcularReparto, BILLETERA_PLATAFORMA } from '../src/reparto/reparto.js'
import { BancoDeBilleteras, correrHastaTerminar } from './arnes.js'

const PESOS: PesosReparto = { creador: 70, vendedor: 10, plataforma: 20 }

function ventaDePrueba(monto: number, conVendedor = true): Venta {
  return {
    pedido_id: 'RY-2026-000001',
    correlacion_id: 'corr-1',
    momento: '2026-08-14T12:00:00Z',
    monto: guaranies(monto),
    comprador_id: 'persona-comprador',
    creador_id: 'persona-creador',
    vendedor_id: conVendedor ? 'persona-vendedor' : null,
  }
}

function bancoSembrado(saldoComprador: number): BancoDeBilleteras {
  const banco = new BancoDeBilleteras()
  banco.sembrar('persona-comprador', guaranies(saldoComprador))
  return banco
}

describe('el reparto, en calma', () => {
  it('reparte exactamente el monto de la venta, sin perder ni inventar un guarani', () => {
    // 100.001 es deliberado: no divide entero por 70/10/20 y fuerza el
    // metodo del resto mayor. Un reparto ingenuo pierde 1 guarani aca.
    const tajadas = calcularReparto(ventaDePrueba(100_001), PESOS)
    const suma = tajadas.reduce((a, t) => a + t.monto, 0)
    expect(suma).toBe(100_001)
  })

  it('sin vendedor, su peso va a la plataforma y el total sigue cuadrando', () => {
    const tajadas = calcularReparto(ventaDePrueba(100_001, false), PESOS)
    expect(tajadas).toHaveLength(2)
    expect(tajadas.reduce((a, t) => a + t.monto, 0)).toBe(100_001)
    const plataforma = tajadas.find((t) => t.papel === 'plataforma')
    expect(plataforma?.monto).toBe(30_000) // 10 + 20 de 100.001, truncado
  })

  it('la ganancia del creador NO entra como disponible', () => {
    // Si entrara como disponible seria retirable de inmediato, y un reembolso
    // posterior a la liquidacion pasaria de ser una regla a ser un juicio.
    const tajadas = calcularReparto(ventaDePrueba(100_000), PESOS)
    const creador = tajadas.find((t) => t.papel === 'creador')
    expect(creador?.bolsa).toBe('ganancia_creador')
  })

  it('completa el reparto y deja el sistema cuadrado', async () => {
    const banco = bancoSembrado(500_000)
    const antes = banco.totalDelSistema()

    await correrHastaTerminar(planificar(ventaDePrueba(100_000), PESOS), banco, null)

    // La plata no se crea ni se destruye: solo cambia de billetera.
    expect(banco.totalDelSistema()).toBe(antes)
    banco.verificarTodas()

    const creador = banco.obtener('persona-creador')
    expect(creador.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(70_000)
  })
})

// ---------------------------------------------------------------------------
// LO QUE IMPORTA: una caida en CADA paso, de los dos tipos
// ---------------------------------------------------------------------------

const PASOS = ['debitar_comprador', 'acreditar_creador', 'acreditar_vendedor', 'acreditar_plataforma']

describe('el reparto, con caida inyectada en cada paso', () => {
  for (let i = 0; i < PASOS.length; i++) {
    for (const cuando of ['antes', 'despues'] as const) {
      it(`sobrevive a una caida ${cuando} de "${PASOS[i]}"`, async () => {
        const banco = bancoSembrado(500_000)
        const total = banco.totalDelSistema()

        const intentos = await correrHastaTerminar(
          planificar(ventaDePrueba(100_001), PESOS),
          banco,
          { enPaso: i, cuando, veces: 1 },
        )

        expect(intentos).toBeGreaterThan(1) // la caida ocurrio de verdad
        expect(banco.totalDelSistema()).toBe(total) // no se perdio ni un guarani
        banco.verificarTodas()

        // Nadie cobro dos veces: los montos finales son los del reparto.
        const tajadas = calcularReparto(ventaDePrueba(100_001), PESOS)
        for (const t of tajadas) {
          const saldo = banco.obtener(t.billetera_id).bolsas.reduce((a, b) => a + b.monto, 0)
          expect(saldo).toBe(t.monto)
        }

        // Y al comprador se le cobro exactamente una vez.
        const comprador = banco.obtener('persona-comprador')
        expect(comprador.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(500_000 - 100_001)
      })
    }
  }

  it('sobrevive a tres caidas seguidas en el mismo paso', async () => {
    const banco = bancoSembrado(500_000)
    const total = banco.totalDelSistema()

    await correrHastaTerminar(
      planificar(ventaDePrueba(100_001), PESOS),
      banco,
      { enPaso: 1, cuando: 'despues', veces: 3 },
    )

    expect(banco.totalDelSistema()).toBe(total)
    banco.verificarTodas()
    expect(banco.obtener('persona-creador').bolsas.reduce((a, b) => a + b.monto, 0)).toBe(70_001)
  })

  it('al reintentar tras una caida DESPUES de aplicar, NO repite los pasos que ya habian terminado', async () => {
    // La idempotencia sola hace que repetir todo sea inofensivo — por eso esta
    // prueba tuvo que escribirse aparte: la mutacion mostro que sin ella nadie
    // notaba si el Workflow reanudaba desde cero.
    //
    // Que sea inofensivo no lo hace gratis: repetir cuatro llamadas entre
    // Durable Objects por cada reintento es latencia y costo reales, y el dia
    // que un paso deje de ser idempotente el defecto ya estaria adentro.
    //
    // 'despues' es el caso peligroso: la billetera YA aplico el cambio cuando
    // el Workflow "cae", asi que el cuarto paso SI se llama dos veces (la
    // idempotencia absorbe la repeticion) — pero los tres primeros, que ya
    // habian terminado, no se repiten.
    const banco = bancoSembrado(500_000)

    await correrHastaTerminar(
      planificar(ventaDePrueba(100_001), PESOS),
      banco,
      { enPaso: 3, cuando: 'despues', veces: 1 },
    )

    // Cinco llamadas y no ocho: los tres primeros pasos corrieron una sola vez,
    // y solo el cuarto —el que fallo— se llamo dos veces.
    expect(banco.llamadas).toHaveLength(5)
    const porClave = new Map<string, number>()
    for (const l of banco.llamadas) porClave.set(l, (porClave.get(l) ?? 0) + 1)

    expect(porClave.get('persona-comprador:debitar:RY-2026-000001:debitar_comprador')).toBe(1)
    expect(porClave.get('persona-creador:acreditar:RY-2026-000001:acreditar_creador')).toBe(1)
    expect(porClave.get('persona-vendedor:acreditar:RY-2026-000001:acreditar_vendedor')).toBe(1)
    expect(porClave.get('plataforma:acreditar:RY-2026-000001:acreditar_plataforma')).toBe(2)
  })

  it('al reintentar tras una caida ANTES de aplicar, cada paso se llama exactamente una vez', async () => {
    // Contraste con la prueba anterior: si la caida es 'antes', el paso que
    // fallo nunca llego a llamar a la billetera, asi que el reintento lo llama
    // por primera y unica vez. Total: cuatro llamadas, una por paso.
    const banco = bancoSembrado(500_000)

    await correrHastaTerminar(
      planificar(ventaDePrueba(100_001), PESOS),
      banco,
      { enPaso: 3, cuando: 'antes', veces: 1 },
    )

    expect(banco.llamadas).toHaveLength(4)
    const porClave = new Map<string, number>()
    for (const l of banco.llamadas) porClave.set(l, (porClave.get(l) ?? 0) + 1)

    expect(porClave.get('persona-comprador:debitar:RY-2026-000001:debitar_comprador')).toBe(1)
    expect(porClave.get('persona-creador:acreditar:RY-2026-000001:acreditar_creador')).toBe(1)
    expect(porClave.get('persona-vendedor:acreditar:RY-2026-000001:acreditar_vendedor')).toBe(1)
    expect(porClave.get('plataforma:acreditar:RY-2026-000001:acreditar_plataforma')).toBe(1)
  })

  it('el reparto entero repetido de punta a punta no paga dos veces', async () => {
    // El caso del publicador que entrega doble (ley 6): el mismo pedido llega
    // dos veces completo. La idempotencia tiene que absorberlo.
    const banco = bancoSembrado(500_000)
    const pasos = planificar(ventaDePrueba(100_001), PESOS)

    await correrHastaTerminar(pasos, banco, null)
    const despuesDelPrimero = banco.totalDelSistema()

    await correrHastaTerminar(planificar(ventaDePrueba(100_001), PESOS), banco, null)

    expect(banco.totalDelSistema()).toBe(despuesDelPrimero)
    expect(banco.obtener('persona-creador').bolsas.reduce((a, b) => a + b.monto, 0)).toBe(70_001)
    expect(banco.obtener(BILLETERA_PLATAFORMA).bolsas.reduce((a, b) => a + b.monto, 0)).toBe(20_000)
    banco.verificarTodas()
  })
})
