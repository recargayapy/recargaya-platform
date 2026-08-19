/**
 * reservar() / liberarReserva() — la implementacion real de la ley 11.
 *
 * El defecto medido (issue "la plata reservada tiene que ser visible para el
 * oraculo"): `reservar()` debitaba la plata con un `debitar()` real y la
 * dejaba viviendo SOLO dentro del Map de reservas, sin bolsa propia. Dos
 * llamadas legitimas con el mismo `reserva_id` (dos claves de idempotencia
 * distintas, no un reintento) pisaban la primera entrada del Map: esa plata
 * quedaba huerfana — salida de su bolsa, asentada en el ledger, sin nada que
 * la reclame — y el oraculo no tenia con que notarlo, porque ledger y bolsas
 * cuadraban igual.
 *
 * El arreglo: la reserva mueve la plata a una bolsa `retenido` de verdad
 * (bolsas.ts), y `reservar()` rechaza de entrada un `reserva_id` que ya
 * tenga una reserva abierta — el pisado del Map ya no puede ocurrir.
 */

import { describe, it, expect } from 'vitest'
import { guaranies } from '../src/dinero/monto.js'
import { saldoRetirable } from '../src/dinero/bolsas.js'
import {
  type EstadoBilletera,
  billeteraVacia,
  acreditar,
  reservar,
  consumirReserva,
  liberarReserva,
  verificarInvariantes,
  ReservaNaceVencida,
  ReservaYaNoEstaAbierta,
  claveAplicada,
} from '../src/billetera/nucleo.js'

const AHORA = '2026-08-14T12:00:00.000Z'
const VENCE_CREDITO = '2026-12-31T00:00:00.000Z'
const VENCE_RESERVA = '2026-08-21T00:00:00.000Z'

function op(clave: string): { clave_idem: string; correlacion_id: string; momento: string } {
  return { clave_idem: clave, correlacion_id: 'c1', momento: AHORA }
}

function billeteraConDosBolsas(): EstadoBilletera {
  const conCredito = acreditar(billeteraVacia('b1'), op('semilla-credito'), {
    monto: guaranies(30_000),
    bolsa: 'credito_promocion',
    concepto: 'promo',
    origen: 'promo-agosto',
    vence_en: VENCE_CREDITO,
  }).estado

  return acreditar(conCredito, op('semilla-disponible'), {
    monto: guaranies(100_000),
    bolsa: 'disponible',
    concepto: 'seed',
    origen: 'semilla',
  }).estado
}

function conReservaAbierta(): EstadoBilletera {
  const inicial = billeteraConDosBolsas()
  return reservar(inicial, op('res-1'), {
    reserva_id: 'r1',
    monto: guaranies(50_000),
    vence_en: VENCE_RESERVA,
  }).estado
}

describe('reservar() toma de varias bolsas con precedencia distinta', () => {
  it('una reserva de 50.000 toma credito_promocion Y disponible a la vez', () => {
    const estado = conReservaAbierta()

    const reserva = estado.reservas.get('r1')
    expect(reserva?.estado).toBe('abierta')
    expect(reserva?.tomas).toHaveLength(2)
    expect(reserva?.tomas.find((t) => t.bolsa.tipo === 'credito_promocion')?.monto).toBe(30_000)
    expect(reserva?.tomas.find((t) => t.bolsa.tipo === 'disponible')?.monto).toBe(20_000)
  })

  it('el oraculo cuadra con la reserva ABIERTA', () => {
    const estado = conReservaAbierta()

    expect(estado.reservas.get('r1')?.estado).toBe('abierta')
    expect(() => verificarInvariantes(estado)).not.toThrow()
  })

  it('la plata reservada vive en la bolsa retenido, no desaparece de las bolsas', () => {
    const estado = conReservaAbierta()

    // Nada se debita "contra la nada": lo que sale de credito_promocion y de
    // disponible aparece, entero, como retenido.
    const retenido = estado.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)
    expect(retenido).toBe(50_000)

    // Cada toma llega a retenido con el reserva_id como origen (paso 1 del
    // arreglo) y con su vencimiento original intacto, para poder devolverse
    // tal cual en liberarReserva().
    const retenidoDelCredito = estado.bolsas.find((b) => b.tipo === 'retenido' && b.vence_en === VENCE_CREDITO)
    expect(retenidoDelCredito?.monto).toBe(30_000)
    expect(retenidoDelCredito?.origen).toBe('r1')

    // retenido no aparece como disponible ni como credito: la bolsa de origen
    // efectivamente perdio esa plata.
    const disponible = estado.bolsas
      .filter((b) => b.tipo === 'disponible')
      .reduce((a, b) => a + b.monto, 0)
    expect(disponible).toBe(100_000 - 20_000)
    expect(estado.bolsas.some((b) => b.tipo === 'credito_promocion')).toBe(false)
  })

  it('retenido no cuenta para el saldo retirable', () => {
    const estado = conReservaAbierta()
    expect(saldoRetirable(estado.bolsas, AHORA)).toBe(100_000 - 20_000)
  })
})

describe('acreditar() rechaza retenido: solo se entra por reservar()', () => {
  it('acreditar con bolsa retenido revienta declarado, no via el invariante al persistir', () => {
    expect(() =>
      acreditar(billeteraVacia('b1'), op('directo'), {
        monto: guaranies(10_000),
        bolsa: 'retenido',
        concepto: 'intento-directo',
        origen: 'quien-sea',
      }),
    ).toThrow(/retenido no se acredita directo/)
  })
})

describe('reservar() rechaza un reserva_id ya usado', () => {
  it('caso medido del issue: dos reservas legitimas con el mismo reserva_id no pisan la primera', () => {
    const inicial = acreditar(billeteraVacia('b1'), op('semilla'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'seed',
      origen: 'semilla',
    }).estado

    const conR1 = reservar(inicial, op('res-1'), {
      reserva_id: 'R1',
      monto: guaranies(30_000),
      vence_en: VENCE_RESERVA,
    }).estado

    // Sin el arreglo, esta segunda llamada pisaba la entrada de R1 en el Map
    // y los 30.000 de la primera reserva quedaban huerfanos.
    expect(() =>
      reservar(conR1, op('res-2'), { reserva_id: 'R1', monto: guaranies(20_000), vence_en: VENCE_RESERVA }),
    ).toThrow(/ya se uso/)

    // La primera reserva sigue entera: nada se perdio.
    expect(conR1.reservas.get('R1')?.tomas.reduce((a, t) => a + t.monto, 0)).toBe(30_000)
    const retenido = conR1.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)
    expect(retenido).toBe(30_000)
    expect(() => verificarInvariantes(conR1)).not.toThrow()

    // liberar despues del intento fallido devuelve exactamente lo reservado,
    // ni un guarani de mas ni de menos.
    const { valor } = liberarReserva(conR1, op('lib-1'), { reserva_id: 'R1' })
    expect(valor.devuelto).toBe(30_000)
  })

  it('un reintento real (misma clave de idempotencia) no choca con el rechazo', () => {
    const inicial = acreditar(billeteraVacia('b1'), op('semilla'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'seed',
      origen: 'semilla',
    }).estado

    const opReserva = op('res-1')
    const primera = reservar(inicial, opReserva, { reserva_id: 'R1', monto: guaranies(30_000), vence_en: VENCE_RESERVA })
    const segunda = reservar(primera.estado, opReserva, {
      reserva_id: 'R1',
      monto: guaranies(30_000),
      vence_en: VENCE_RESERVA,
    })

    expect(segunda.repetida).toBe(true)
    expect(segunda.valor).toEqual(primera.valor)
  })

  it('un reserva_id ya liberado TAMPOCO se puede volver a usar', () => {
    // Esta prueba afirmaba lo contrario, y una auditoria adversarial la volteo
    // midiendo tres daños distintos del mismo reuso sobre workerd. El peor:
    // `tomas` tiene PK `(reserva_id, orden)` y se escribe con `INSERT OR IGNORE`,
    // asi que con el id reusado las tomas NUEVAS se descartan en silencio y quedan
    // las de la reserva vieja. Medido: retenido 50.000 en bolsas contra 20.000 en
    // reservas, y de ahi en adelante TODA operacion sobre esa billetera tira por
    // el invariante 3 — incluida `liberarReserva`. La plata queda adentro sin
    // camino de salida.
    //
    // Los otros dos: el upsert de `reservas` no toca `vence_en` (la reserva nueva
    // hereda el vencimiento de la vieja), y la clave del vencimiento es
    // `vencimiento:<reserva_id>`, asi que la segunda expiracion sale por
    // `aplicadas` como repetida mientras la alarma se reprograma para «ahora» en
    // bucle.
    //
    // Se podia arreglar cada uno. Se arreglo la categoria: el reserva_id ES la
    // identidad del ciclo de vida. Otra reserva, otro id.
    const inicial = acreditar(billeteraVacia('b1'), op('semilla'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'seed',
      origen: 'semilla',
    }).estado

    const conR1 = reservar(inicial, op('res-1'), { reserva_id: 'R1', monto: guaranies(30_000), vence_en: VENCE_RESERVA }).estado
    const liberado = liberarReserva(conR1, op('lib-1'), { reserva_id: 'R1' }).estado
    expect(liberado.reservas.get('R1')?.estado).toBe('cancelada')

    expect(() =>
      reservar(liberado, op('res-2'), { reserva_id: 'R1', monto: guaranies(10_000), vence_en: VENCE_RESERVA }),
    ).toThrow(/ya se uso \(quedo cancelada\)/)

    // Y un id distinto sobre el mismo estado si anda: lo que se rechaza es el
    // reuso, no reservar de nuevo.
    expect(() =>
      reservar(liberado, op('res-3'), { reserva_id: 'R2', monto: guaranies(10_000), vence_en: VENCE_RESERVA }),
    ).not.toThrow()
  })
})

describe('liberarReserva() — la regla anticajero por el camino real', () => {
  it('cada guarani vuelve a su bolsa de origen, con el vencimiento original', () => {
    const estado = conReservaAbierta()

    const { estado: liberado, valor } = liberarReserva(estado, op('lib-1'), { reserva_id: 'r1' })

    expect(valor.devuelto).toBe(50_000)
    expect(liberado.reservas.get('r1')?.estado).toBe('cancelada')

    const credito = liberado.bolsas.find((b) => b.tipo === 'credito_promocion' && b.origen === 'promo-agosto')
    expect(credito?.monto).toBe(30_000)
    expect(credito?.vence_en).toBe(VENCE_CREDITO) // no se renueva

    const disponible = liberado.bolsas
      .filter((b) => b.tipo === 'disponible' && b.origen === 'semilla')
      .reduce((a, b) => a + b.monto, 0)
    // 100.000 originales: se fueron 20.000 con la reserva, volvieron los mismos 20.000.
    expect(disponible).toBe(100_000)

    expect(() => verificarInvariantes(liberado)).not.toThrow()
  })

  it('liberar dos veces con la misma clave de idempotencia no devuelve doble', () => {
    const estado = conReservaAbierta()
    const opLiberar = op('lib-1')

    const primera = liberarReserva(estado, opLiberar, { reserva_id: 'r1' })
    const segunda = liberarReserva(primera.estado, opLiberar, { reserva_id: 'r1' })

    expect(segunda.repetida).toBe(true)
    expect(segunda.valor.devuelto).toBe(primera.valor.devuelto)

    const totalBolsas = (e: EstadoBilletera): number => e.bolsas.reduce((a, b) => a + b.monto, 0)
    expect(totalBolsas(segunda.estado)).toBe(totalBolsas(primera.estado))
    expect(() => verificarInvariantes(segunda.estado)).not.toThrow()
  })
})

describe('consumirReserva() — el consumo que cruza mas de una bolsa retenida', () => {
  // ESTAS PRUEBAS EXISTEN PORQUE FALTABAN, y lo midio una auditoria adversarial:
  // `consumirReserva` no aparecia en un solo archivo de `tests/`, y las cinco
  // llamadas del runtime consumian siempre un monto que entraba entero en la
  // PRIMERA toma. Con `porConsumir -= saca` reemplazado por `porConsumir = 0`
  // —o sea, consumir solo de la primera bolsa y nunca seguir— las dos suites
  // completas pasaban: 73 del nucleo y 48 sobre workerd.
  //
  // Es la funcion nueva de la entrega y la que mas plata mueve por rama. Y sus
  // mutaciones estaban declaradas con el oraculo del runtime, que es el caro:
  // la funcion es pura y no toca Cloudflare, asi que su lugar es acá.

  /** 30.000 de credito que vence antes + 70.000 de disponible. La precedencia
   *  toma primero el credito, asi que una reserva de 50.000 sale de DOS bolsas:
   *  30.000 del credito y 20.000 del disponible. Ese es el estado que hace falta
   *  para que el bucle del reparto tenga algo que repartir. */
  function conReservaDeDosTomas(): EstadoBilletera {
    const conCredito = acreditar(billeteraVacia('b1'), op('sem-cred'), {
      monto: guaranies(30_000),
      bolsa: 'credito_promocion',
      concepto: 'premio',
      origen: 'promo-agosto',
      vence_en: VENCE_CREDITO,
    }).estado
    const conDisponible = acreditar(conCredito, op('sem-disp'), {
      monto: guaranies(70_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'semilla',
    }).estado
    const r = reservar(conDisponible, op('res-1'), {
      reserva_id: 'r1',
      monto: guaranies(50_000),
      vence_en: VENCE_RESERVA,
    }).estado

    // La premisa de todo este describe. Si algun dia la precedencia cambia y la
    // reserva sale de una sola bolsa, estas pruebas dejan de probar lo que dicen
    // — y esta linea lo grita en vez de dejarlas pasar en verde.
    expect(r.reservas.get('r1')?.tomas.length).toBe(2)
    return r
  }

  const retenidoDe = (e: EstadoBilletera) =>
    e.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)

  it('un consumo que entra en la primera toma no toca la segunda', () => {
    const estado = conReservaDeDosTomas()
    const { estado: despues, valor } = consumirReserva(estado, op('u1'), {
      reserva_id: 'r1',
      monto: guaranies(10_000),
    })

    expect(valor.consumido).toBe(10_000)
    expect(valor.disponible).toBe(40_000)
    expect(retenidoDe(despues)).toBe(40_000)
    // Quedan las dos bolsas: la primera mordida, la segunda intacta.
    const retenidas = despues.bolsas.filter((b) => b.tipo === 'retenido')
    expect(retenidas.map((b) => b.monto)).toEqual([20_000, 20_000])
    expect(() => verificarInvariantes(despues)).not.toThrow()
  })

  it('un consumo que CRUZA la primera toma sigue en la segunda', () => {
    // 40.000 sobre tomas de 30.000 + 20.000: se vacia la primera y se muerden
    // 10.000 de la segunda. Es el caso que ninguna prueba ejercitaba.
    const estado = conReservaDeDosTomas()
    const { estado: despues, valor } = consumirReserva(estado, op('u1'), {
      reserva_id: 'r1',
      monto: guaranies(40_000),
    })

    expect(valor.consumido).toBe(40_000)
    expect(valor.disponible).toBe(10_000)
    // LA asercion: si el bucle se cortara en la primera bolsa, acá quedarian
    // 20.000 en vez de 10.000 — o sea 10.000 retenidos que `consumido` ya dio
    // por gastados. Plata contada dos veces.
    expect(retenidoDe(despues)).toBe(10_000)
    expect(despues.bolsas.filter((b) => b.tipo === 'retenido').map((b) => b.monto)).toEqual([10_000])
    expect(() => verificarInvariantes(despues)).not.toThrow()
  })

  it('consumir la reserva ENTERA vacia las dos bolsas retenidas', () => {
    const estado = conReservaDeDosTomas()
    const { estado: despues, valor } = consumirReserva(estado, op('u1'), {
      reserva_id: 'r1',
      monto: guaranies(50_000),
    })

    expect(valor.consumido).toBe(50_000)
    expect(valor.disponible).toBe(0)
    expect(despues.bolsas.filter((b) => b.tipo === 'retenido')).toEqual([])
    expect(() => verificarInvariantes(despues)).not.toThrow()
  })

  it('dos consumos sucesivos cruzan el limite igual que uno solo', () => {
    // El estado intermedio existe de verdad —se persiste entre una llamada y la
    // otra— asi que el segundo consumo arranca de bolsas ya mordidas.
    const estado = conReservaDeDosTomas()
    const uno = consumirReserva(estado, op('u1'), { reserva_id: 'r1', monto: guaranies(25_000) }).estado
    const dos = consumirReserva(uno, op('u2'), { reserva_id: 'r1', monto: guaranies(15_000) })

    expect(dos.valor.consumido).toBe(40_000)
    expect(retenidoDe(dos.estado)).toBe(10_000)
    expect(() => verificarInvariantes(dos.estado)).not.toThrow()
  })

  it('lo consumido NO vuelve: liberar despues devuelve solo el remanente', () => {
    // El otro lado de la ley 11. Lo que se gasto salio de la billetera; lo que
    // queda vuelve A SU BOLSA DE ORIGEN, y `devolver()` entrega en orden inverso
    // —desde la ultima toma hacia atras— asi que lo que vuelve es el disponible y
    // no el credito que estaba por vencer.
    const estado = conReservaDeDosTomas()
    const consumido = consumirReserva(estado, op('u1'), {
      reserva_id: 'r1',
      monto: guaranies(40_000),
    }).estado

    const { estado: libre, valor } = liberarReserva(consumido, op('lib-1'), { reserva_id: 'r1' })
    expect(valor.devuelto).toBe(10_000)
    expect(libre.bolsas.filter((b) => b.tipo === 'retenido')).toEqual([])
    // 100.000 - 40.000 gastados.
    expect(libre.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(60_000)
    expect(() => verificarInvariantes(libre)).not.toThrow()
  })

  it('no se puede consumir mas de lo que queda, ni por un guarani', () => {
    const estado = conReservaDeDosTomas()
    const uno = consumirReserva(estado, op('u1'), { reserva_id: 'r1', monto: guaranies(20_000) }).estado

    expect(() =>
      consumirReserva(uno, op('u2'), { reserva_id: 'r1', monto: guaranies(30_001) }),
    ).toThrow(/quedan 30000/)
    expect(() =>
      consumirReserva(uno, op('u3'), { reserva_id: 'r1', monto: guaranies(30_000) }),
    ).not.toThrow()
  })

  it('una reserva que no esta abierta no se consume', () => {
    const estado = conReservaDeDosTomas()
    const libre = liberarReserva(estado, op('lib-1'), { reserva_id: 'r1' }).estado

    expect(() =>
      consumirReserva(libre, op('u1'), { reserva_id: 'r1', monto: guaranies(1_000) }),
    ).toThrow(/no esta abierta/)
    expect(() =>
      consumirReserva(libre, op('u2'), { reserva_id: 'no-existe', monto: guaranies(1_000) }),
    ).toThrow(/reserva desconocida/)
  })

  it('consumir cero o negativo no es consumir', () => {
    const estado = conReservaDeDosTomas()
    for (const monto of [0, -1]) {
      expect(() =>
        consumirReserva(estado, op('u1'), { reserva_id: 'r1', monto: guaranies(monto) }),
      ).toThrow(/monto positivo/)
    }
  })

  it('el mismo consumo con la misma clave no gasta dos veces', () => {
    const estado = conReservaDeDosTomas()
    const primera = consumirReserva(estado, op('u1'), { reserva_id: 'r1', monto: guaranies(40_000) })
    const segunda = consumirReserva(primera.estado, op('u1'), {
      reserva_id: 'r1',
      monto: guaranies(40_000),
    })

    expect(segunda.repetida).toBe(true)
    expect(segunda.valor).toEqual(primera.valor)
    expect(retenidoDe(segunda.estado)).toBe(retenidoDe(primera.estado))
  })
})

// ---------------------------------------------------------------------------
// Las dos vueltas de auditoria de la entrega 1.3
// ---------------------------------------------------------------------------

describe('reservar() no crea una reserva que naceria vencida', () => {
  it('un vence_en anterior al momento se rechaza', () => {
    // `acreditar` tiene este guarda desde la 1.2, agregado por una auditoria con este
    // argumento: plata que entra al ledger, cuenta en los totales, pasa los
    // invariantes, y es inconsumible para siempre. `reservar` es la OTRA puerta por la
    // que entra un vencimiento de afuera y no lo tenia — dos de dos, una arreglada,
    // que es la forma mas facil de creer que se arreglo la categoria.
    //
    // Medido en la 1.3: con un `vence_en` en el pasado, `reservar()` contestaba bien y
    // la alarma devolvia la plata en milisegundos. El llamador se llevaba un 200 con
    // `estado: reservado` sobre una reserva que ya no existia.
    expect(() =>
      reservar(billeteraConDosBolsas(), op('rv-1'), {
        reserva_id: 'rv-1',
        monto: guaranies(10_000),
        vence_en: '2026-08-14T11:59:59.999Z',
      }),
    ).toThrow(ReservaNaceVencida)
  })

  it('un vence_en EXACTAMENTE igual al momento tambien', () => {
    // El borde, y del lado que corresponde: una reserva que vence en el instante en
    // que nace no retiene nada durante ningun instante. Es el mismo criterio de borde
    // que usan las bolsas (`vence_en <= momento` ⇒ vencida) y las capacidades.
    expect(() =>
      reservar(billeteraConDosBolsas(), op('rv-2'), {
        reserva_id: 'rv-2',
        monto: guaranies(10_000),
        vence_en: AHORA,
      }),
    ).toThrow(ReservaNaceVencida)
  })

  it('un milisegundo despues, si', () => {
    // El control. Sin esto, un guarda que rechazara TODO pasaria las dos de arriba.
    expect(() =>
      reservar(billeteraConDosBolsas(), op('rv-3'), {
        reserva_id: 'rv-3',
        monto: guaranies(10_000),
        vence_en: '2026-08-14T12:00:00.001Z',
      }),
    ).not.toThrow()
  })
})

describe('la puerta de idempotencia no dice que la reserva siga viva', () => {
  it('reintentar una reserva que ya no esta abierta NO contesta que si', () => {
    // El hallazgo: `puertaDeEntrada` contesta «esto ya se aplico», que no es «esto
    // sigue vigente». El camino medido: el Worker muere despues de que la billetera
    // confirmo la reserva y antes de que D1 anote `reservado`; pasan treinta minutos y
    // la alarma libera la reserva vencida; recien ahi llega el reintento del llamador
    // con la misma clave. La version anterior contestaba `repetida: true`, el
    // orquestador anotaba `reservado`, y quedaba un pedido diciendo retener 30.000 Gs.
    // sobre una billetera que no retiene nada.
    const conReserva = conReservaAbierta()
    const liberada = liberarReserva(conReserva, op('lib-1'), { reserva_id: 'r1' }).estado

    expect(() =>
      reservar(liberada, op('res-1'), {
        reserva_id: 'r1',
        monto: guaranies(50_000),
        vence_en: VENCE_RESERVA,
      }),
    ).toThrow(ReservaYaNoEstaAbierta)
  })

  it('pero el reintento de una reserva que SIGUE abierta contesta repetida', () => {
    // El control, y es la mitad que importa: el reintento honesto —el que existe para
    // que un POST cortado se pueda repetir— tiene que seguir funcionando. Un guarda
    // que tirara siempre pasaria la prueba de arriba y rompería la idempotencia.
    const r = reservar(conReservaAbierta(), op('res-1'), {
      reserva_id: 'r1',
      monto: guaranies(50_000),
      vence_en: VENCE_RESERVA,
    })
    expect(r.repetida).toBe(true)
    expect(r.valor.reserva_id).toBe('r1')
    expect(r.asientos).toEqual([])
  })
})

describe('cada operacion se acuerda de lo suyo y de nada mas', () => {
  it('una acreditacion con la clave de una reserva NO se hace pasar por ella', () => {
    // El hallazgo mas caro de la 1.3, en su forma pura. Hasta entonces la clave era el
    // `clave_idem` PELADO, o sea que las cinco operaciones compartian un espacio de
    // nombres, y el `clave_idem` lo elige el llamador.
    const envenenada = acreditar(billeteraConDosBolsas(), op('pedido:RY-2026-000001:reserva'), {
      monto: guaranies(1),
      bolsa: 'disponible',
      concepto: 'veneno',
      origen: 'afuera',
    }).estado

    const r = reservar(envenenada, op('pedido:RY-2026-000001:reserva'), {
      reserva_id: 'RY-2026-000001',
      monto: guaranies(50_000),
      vence_en: VENCE_RESERVA,
    })

    // La reserva se hizo DE VERDAD: no salio por la puerta con el valor de la
    // acreditacion.
    expect(r.repetida).toBe(false)
    expect(r.asientos.length).toBeGreaterThan(0)
    expect(r.estado.reservas.get('RY-2026-000001')?.estado).toBe('abierta')
    verificarInvariantes(r.estado)
  })

  it('la clave lleva el nombre de la operacion adentro', () => {
    expect(claveAplicada('acreditar', 'x')).not.toBe(claveAplicada('reservar', 'x'))
    expect(claveAplicada('reservar', 'x')).not.toBe(claveAplicada('liberar', 'x'))
    expect(claveAplicada('debitar', 'x')).not.toBe(claveAplicada('consumir', 'x'))
  })
})
