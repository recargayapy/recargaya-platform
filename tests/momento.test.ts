/**
 * El instante, la otra magnitud que ordena plata.
 *
 * Lo encontro una auditoria adversarial: el vencimiento decide de quien es un
 * guarani comparando TEXTO (`bolsa.vence_en <= momento`) y la alarma decide cuando
 * despertar convirtiendo a NUMERO (`Date.parse`). Las dos formas coinciden solo si
 * todos los instantes estan escritos igual. Con otro huso dejan de coincidir, y
 * nada falla: la plata se cuenta mal.
 */
import { describe, it, expect } from 'vitest'
import { InstanteInvalido, instante, instanteOpcional } from '../src/dinero/momento.js'
import {
  billeteraVacia,
  acreditar,
  reservar,
  verificarInvariantes,
} from '../src/billetera/nucleo.js'
import { guaranies } from '../src/dinero/monto.js'

describe('instante()', () => {
  it('acepta UTC ISO-8601, con y sin milisegundos', () => {
    expect(instante('2026-08-17T12:00:00Z')).toBe('2026-08-17T12:00:00Z')
    expect(instante('2026-08-17T12:00:00.000Z')).toBe('2026-08-17T12:00:00.000Z')
    // Y lo que produce el propio runtime, que es de donde salen los instantes
    // que no escribe una persona.
    expect(() => instante(new Date().toISOString())).not.toThrow()
  })

  it('rechaza el huso que no es Z, que es EL caso', () => {
    // La comparacion de texto y la del reloj dan resultados OPUESTOS. Escrito
    // como afirmacion para que quede medido y no dicho, con America/Asuncion que
    // es el huso del proyecto.
    const conHuso = '2026-08-18T23:00:00.000-03:00' // = 2026-08-19T02:00:00Z
    const enZeta = '2026-08-19T01:00:00.000Z'

    expect(conHuso <= enZeta).toBe(true) // texto : el 18 viene antes que el 19
    expect(Date.parse(conHuso) <= Date.parse(enZeta)).toBe(false) // reloj: es DESPUES

    // Eso es exactamente `decidirConsumo` contra `reprogramarAlarma`: uno diria
    // que la bolsa esta vigente y el otro que ya vencio.
    expect(() => instante(conHuso)).toThrow(InstanteInvalido)
    expect(() => instante('2026-08-18T04:00:00+00:00')).toThrow(/UTC ISO-8601 con Z/)
  })

  it('rechaza lo que no tiene forma de instante', () => {
    for (const malo of [
      '2026-08-17', // sin hora
      '2026-08-17 12:00:00Z', // sin la T
      '2026-08-17T12:00Z', // sin segundos
      '2026-08-17T12:00:00', // sin Z
      '2026-08-17T12:00:00.1Z', // precision rara
      'ayer',
      '',
    ]) {
      expect(() => instante(malo), `deberia rechazar ${malo}`).toThrow(InstanteInvalido)
    }
  })

  it('rechaza lo que no es texto', () => {
    for (const malo of [null, undefined, 42, {}, new Date()]) {
      expect(() => instante(malo)).toThrow(/se esperaba texto/)
    }
  })

  it('rechaza una fecha que tiene la forma y no existe', () => {
    // `2026-02-30` pasa la expresion regular y JavaScript la corre en silencio a
    // `2026-03-02`. Una fecha corrida dos dias es peor que un error: despues todo
    // el sistema compara contra algo que nadie escribio.
    expect(() => instante('2026-02-30T12:00:00Z')).toThrow(/no es una fecha real/)
    expect(() => instante('2026-13-01T12:00:00Z')).toThrow(InstanteInvalido)
    expect(() => instante('2026-08-17T25:00:00Z')).toThrow(InstanteInvalido)
    // Y un año bisiesto de verdad SI entra, para que la comprobacion no sea
    // "rechaza todo lo raro".
    expect(() => instante('2028-02-29T12:00:00Z')).not.toThrow()
  })

  it('instanteOpcional deja pasar la ausencia y no la mala escritura', () => {
    expect(instanteOpcional(null)).toBeNull()
    expect(instanteOpcional(undefined)).toBeNull()
    expect(instanteOpcional('2026-08-17T12:00:00Z')).toBe('2026-08-17T12:00:00Z')
    // Una bolsa sin vencimiento es legitima; una con un vencimiento mal escrito no.
    expect(() => instanteOpcional('2026-08-17T12:00:00-03:00')).toThrow(InstanteInvalido)
  })
})

describe('la puerta: ninguna operacion entra con un instante mal escrito', () => {
  const bien = {
    monto: guaranies(10_000),
    bolsa: 'disponible' as const,
    concepto: 'carga',
    origen: 'dpago',
  }
  const op = (momento: string) => ({ clave_idem: 'k1', correlacion_id: 'c1', momento })

  it('el `momento` de la operacion se revisa, en las cinco operaciones', () => {
    // Se revisa en `puertaDeEntrada`, que es la primera linea de las cinco. Un
    // lugar, no cinco — la sexta operacion no se lo puede olvidar.
    expect(() => acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00-03:00'), bien)).toThrow(
      InstanteInvalido,
    )
    expect(() => acreditar(billeteraVacia('b1'), op('ayer'), bien)).toThrow(InstanteInvalido)
  })

  it('el `vence_en` de una acreditacion se revisa', () => {
    expect(() =>
      acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00Z'), {
        ...bien,
        bolsa: 'credito_promocion',
        vence_en: '2026-12-31T00:00:00-03:00',
      }),
    ).toThrow(InstanteInvalido)
  })

  it('el `vence_en` de una reserva se revisa', () => {
    const conSaldo = acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00Z'), bien).estado
    expect(() =>
      reservar(conSaldo, { clave_idem: 'r1', correlacion_id: 'c1', momento: '2026-08-17T12:00:00Z' }, {
        reserva_id: 'promo-1',
        monto: guaranies(1_000),
        vence_en: '2026-08-17T13:00:00+00:00',
      }),
    ).toThrow(InstanteInvalido)
  })

  it('y el rechazo no deja nada a medias', () => {
    const conSaldo = acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00Z'), bien).estado
    try {
      reservar(conSaldo, { clave_idem: 'r1', correlacion_id: 'c1', momento: '2026-08-17T12:00:00Z' }, {
        reserva_id: 'promo-1',
        monto: guaranies(1_000),
        vence_en: 'cuando sea',
      })
    } catch {
      /* esperado */
    }
    expect(conSaldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(10_000)
    expect(conSaldo.reservas.size).toBe(0)
    expect(() => verificarInvariantes(conSaldo)).not.toThrow()
  })
})
