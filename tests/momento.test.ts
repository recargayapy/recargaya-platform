/**
 * El instante, la otra magnitud que ordena plata.
 *
 * Lo encontro una auditoria adversarial: el vencimiento decide de quien es un
 * guarani comparando TEXTO (`bolsa.vence_en <= momento`) y la alarma decide cuando
 * despertar convirtiendo a NUMERO (`Date.parse`). Las dos formas coinciden solo si
 * todos los instantes estan escritos EXACTAMENTE igual. Si difieren —en el huso o
 * en la precision— dejan de coincidir, y nada falla: la plata se cuenta mal.
 *
 * La segunda vuelta de auditoria encontro que la primera version de este oraculo
 * tenia el defecto adentro: aceptaba los milisegundos como opcionales, afirmando
 * que las dos formas ordenaban igual. No ordenan igual. Hoy hay UNA forma.
 */
import { describe, it, expect } from 'vitest'
import { InstanteInvalido, anioEnZona, instante, instanteOpcional } from '../src/dinero/momento.js'
import {
  billeteraVacia,
  acreditar,
  reservar,
  verificarInvariantes,
} from '../src/billetera/nucleo.js'
import { guaranies } from '../src/dinero/monto.js'

describe('instante()', () => {
  it('acepta UNA sola forma: la de ancho fijo, con milisegundos', () => {
    expect(instante('2026-08-17T12:00:00.000Z')).toBe('2026-08-17T12:00:00.000Z')
    // Y lo que produce el propio runtime, que es de donde salen los instantes
    // que no escribe una persona.
    expect(() => instante(new Date().toISOString())).not.toThrow()
  })

  it('rechaza la forma SIN milisegundos, y ese es el arreglo de la segunda vuelta', () => {
    // La primera version la aceptaba, diciendo que las dos formas «ordenan igual
    // entre si». Es falso, y por el caracter: `.` es 0x2E y `Z` es 0x5A, asi que
    // dentro del mismo segundo la forma LARGA ordena antes que la corta — al reves
    // que el reloj.
    const corta = '2026-08-17T12:00:00Z'
    const larga = '2026-08-17T12:00:00.500Z'
    expect(corta <= larga).toBe(false) // texto : la corta va DESPUES
    expect(Date.parse(corta) <= Date.parse(larga)).toBe(true) // reloj: va antes

    // Medido de punta a punta: con un `vence_en` corto, `reservasVencidas` (texto)
    // decia TODAVIA NO mientras `cuandoDespertar` (reloj) decia YA, y la alarma
    // giraba en vacio hasta el segundo siguiente.
    expect(() => instante(corta)).toThrow(/milisegundos/)
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
    expect(() => instante('2026-08-18T04:00:00.000+00:00')).toThrow(/UTC ISO-8601 con milisegundos y Z/)
  })

  it('rechaza lo que no tiene forma de instante', () => {
    for (const malo of [
      '2026-08-17', // sin hora
      '2026-08-17 12:00:00Z', // sin la T
      '2026-08-17T12:00Z', // sin segundos
      '2026-08-17T12:00:00.000', // sin Z
      '2026-08-17T12:00:00.1Z', // precision rara
      '2026-08-17T12:00:00.0000Z', // precision de mas
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
    expect(() => instante('2026-02-30T12:00:00.000Z')).toThrow(/no es una fecha real/)
    expect(() => instante('2026-13-01T12:00:00.000Z')).toThrow(InstanteInvalido)
    expect(() => instante('2026-08-17T25:00:00.000Z')).toThrow(InstanteInvalido)
    // Y un año bisiesto de verdad SI entra, para que la comprobacion no sea
    // "rechaza todo lo raro".
    expect(() => instante('2028-02-29T12:00:00.000Z')).not.toThrow()
  })

  it('instanteOpcional deja pasar la ausencia y no la mala escritura', () => {
    expect(instanteOpcional(null)).toBeNull()
    expect(instanteOpcional(undefined)).toBeNull()
    expect(instanteOpcional('2026-08-17T12:00:00.000Z')).toBe('2026-08-17T12:00:00.000Z')
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
      acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00.000Z'), {
        ...bien,
        bolsa: 'credito_promocion',
        vence_en: '2026-12-31T00:00:00.000-03:00',
      }),
    ).toThrow(InstanteInvalido)
  })

  it('el `vence_en` de una reserva se revisa', () => {
    const conSaldo = acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00.000Z'), bien).estado
    expect(() =>
      reservar(conSaldo, { clave_idem: 'r1', correlacion_id: 'c1', momento: '2026-08-17T12:00:00.000Z' }, {
        reserva_id: 'promo-1',
        monto: guaranies(1_000),
        vence_en: '2026-08-17T13:00:00.000+00:00',
      }),
    ).toThrow(InstanteInvalido)
  })

  it('se revisa TAMBIEN cuando la operacion es repetida', () => {
    // La promesa esta escrita en `puertaDeEntrada` —«revisa incluso cuando la
    // operacion resulta repetida»— y una auditoria midio que nada la sostenia:
    // moviendo `instante(op.momento)` detras del corto-circuito de idempotencia,
    // las 94 pruebas pasaban igual. Es el orden de dos lineas, y ahora tiene
    // oraculo.
    const primera = acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00.000Z'), bien)
    expect(primera.repetida).toBe(false)

    // MISMA clave de idempotencia, o sea repetida, con el momento mal escrito.
    expect(() =>
      acreditar(primera.estado, op('2026-08-17T12:00:00-03:00'), bien),
    ).toThrow(InstanteInvalido)

    // Control positivo: repetida y bien escrita si pasa, y devuelve lo de antes.
    const segunda = acreditar(primera.estado, op('2026-08-17T12:00:00.000Z'), bien)
    expect(segunda.repetida).toBe(true)
  })

  it('y el rechazo no deja nada a medias', () => {
    const conSaldo = acreditar(billeteraVacia('b1'), op('2026-08-17T12:00:00.000Z'), bien).estado
    try {
      reservar(conSaldo, { clave_idem: 'r1', correlacion_id: 'c1', momento: '2026-08-17T12:00:00.000Z' }, {
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

/**
 * El año en una zona horaria. La unica salida de `momento.ts` que no es UTC, y la
 * que decide el año del numero de pedido.
 *
 * Estas pruebas MIDEN el borde, que es lo unico que importa acá: los 364 dias del
 * año en que las dos respuestas coinciden no prueban nada.
 */
describe('anioEnZona()', () => {
  const ASUNCION = 'America/Asuncion'

  it('un dia cualquiera coincide con UTC', () => {
    expect(anioEnZona(instante('2026-08-18T15:00:00.000Z'), ASUNCION)).toBe(2026)
  })

  it('EL BORDE: las tres ultimas horas del año en Asuncion todavia son el año viejo', () => {
    // Esto es el defecto entero, medido. `momento.slice(0, 4)` contesta 2027 para
    // los tres instantes de abajo, y los tres son el 31 de diciembre en Asuncion.
    //
    // Paraguay esta en UTC-03:00, asi que la medianoche local del 1 de enero de 2027
    // ocurre a las 03:00Z. Un milisegundo antes todavia es 2026.
    expect(anioEnZona(instante('2027-01-01T00:00:00.000Z'), ASUNCION)).toBe(2026)
    expect(anioEnZona(instante('2027-01-01T02:59:59.999Z'), ASUNCION)).toBe(2026)
    // Y en ese instante exacto, ya es 2027.
    expect(anioEnZona(instante('2027-01-01T03:00:00.000Z'), ASUNCION)).toBe(2027)
  })

  it('el borde de arriba: el 31 de diciembre a las 21:00 en Asuncion sigue siendo el año viejo', () => {
    expect(anioEnZona(instante('2026-12-31T23:59:59.999Z'), ASUNCION)).toBe(2026)
  })

  it('en UTC el borde es la medianoche, que es lo que confirma que la zona hace algo', () => {
    // Si `anioEnZona` ignorara la zona, esta prueba y la del borde de Asuncion
    // darian el mismo resultado y ninguna de las dos probaria nada.
    expect(anioEnZona(instante('2027-01-01T00:00:00.000Z'), 'UTC')).toBe(2027)
    expect(anioEnZona(instante('2026-12-31T23:59:59.999Z'), 'UTC')).toBe(2026)
  })

  it('una zona que no existe rompe RUIDOSAMENTE', () => {
    // Un despliegue mal configurado tiene que romper, no numerar pedidos con el año
    // equivocado en silencio. `Intl` tira `RangeError`.
    expect(() => anioEnZona(instante('2026-08-18T15:00:00.000Z'), 'America/Asuncionn')).toThrow()
    expect(() => anioEnZona(instante('2026-08-18T15:00:00.000Z'), '')).toThrow()
  })

  it('devuelve un numero entero, no el texto', () => {
    const a = anioEnZona(instante('2026-08-18T15:00:00.000Z'), ASUNCION)
    expect(typeof a).toBe('number')
    expect(Number.isInteger(a)).toBe(true)
  })
})
