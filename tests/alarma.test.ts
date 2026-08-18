/**
 * Cuando despierta el Durable Object, probado sin Durable Object.
 *
 * Estas pruebas existen por un fallo del arnes de mutacion, y conviene dejarlo
 * escrito: con estas ramas adentro de `reprogramarAlarma`, la mutacion que sacaba
 * la de «hay reservas YA vencidas» SOBREVIVIO a cuarenta y ocho pruebas del
 * runtime. No porque la rama sobrara — sobre eso hay una prueba explicita mas
 * abajo — sino porque el estado donde esa rama manda («vencido y con el outbox
 * vacio») solo se puede observar desde afuera del objeto ganandole una carrera a
 * la alarma que se dispara sola.
 *
 * Acá el estado se escribe en cuatro campos y se afirma sobre el numero. Sin
 * runtime, sin reloj, sin carrera.
 */
import { describe, it, expect } from 'vitest'
import { cuandoDespertar } from '../src/billetera/alarma.js'
import { RETRASO_MAXIMO_MS } from '../src/billetera/publicador.js'

const AHORA = Date.parse('2026-08-17T12:00:00.000Z')
const EN_MEDIA_HORA = '2026-08-17T12:30:00.000Z'

/** El estado sin ningun motivo. Cada prueba enciende lo que le interesa. */
const nada = {
  ahora: AHORA,
  intentosDeLasVencidas: null,
  proximoVencimiento: null,
  intentosDeLaCabeza: null,
} as const

describe('cuando despertar al Durable Object', () => {
  it('sin ningun motivo, no hay alarma', () => {
    // `null` significa BORRAR la alarma. Una alarma sin motivo despierta al objeto
    // para nada, para siempre.
    expect(cuandoDespertar(nada)).toBeNull()
  })

  it('con una reserva por vencer, la alarma va a su vencimiento', () => {
    expect(cuandoDespertar({ ...nada, proximoVencimiento: EN_MEDIA_HORA })).toBe(
      Date.parse(EN_MEDIA_HORA),
    )
  })

  it('con algo YA vencido, la alarma va para ahora mismo', () => {
    expect(cuandoDespertar({ ...nada, intentosDeLasVencidas: 0 })).toBe(AHORA)
  })

  it('lo YA vencido no puede quedar sin alarma aunque el outbox este vacio', () => {
    // ESTA es la prueba que faltaba, y el estado que describe es exactamente donde
    // termina `alarm()`: publica —lo que vacia el outbox— y despues reprograma. Si
    // una reserva vencio en el medio, este es el unico motivo que queda.
    //
    // `reservasVencidas` devuelve como «proximo vencimiento» solo lo que vence MAS
    // ADELANTE, asi que lo ya vencido no aparece por ese lado. Sin la rama de
    // `hayVencidas`, acá no hay ningun motivo, la alarma se borra, y esa plata
    // queda retenida para siempre sin que nadie se entere.
    const r = cuandoDespertar({
      ...nada,
      intentosDeLasVencidas: 0,
      proximoVencimiento: null,
      intentosDeLaCabeza: null,
    })
    expect(r).not.toBeNull()
    expect(r).toBe(AHORA)
  })

  it('con el outbox pendiente y sin fallos, la alarma va para ahora mismo', () => {
    // Cero intentos → cero espera. Es lo que hace que la copia a D1 salga apenas
    // la operacion suelta el objeto, sin que el que movio la plata pague esa
    // latencia en su propia llamada.
    expect(cuandoDespertar({ ...nada, intentosDeLaCabeza: 0 })).toBe(AHORA)
  })

  it('con el outbox fallando, la alarma se aleja segun los intentos', () => {
    expect(cuandoDespertar({ ...nada, intentosDeLaCabeza: 1 })).toBe(AHORA + 1_000)
    expect(cuandoDespertar({ ...nada, intentosDeLaCabeza: 3 })).toBe(AHORA + 4_000)
    expect(cuandoDespertar({ ...nada, intentosDeLaCabeza: 50 })).toBe(AHORA + RETRASO_MAXIMO_MS)
  })

  it('entre dos motivos gana el MAS CERCANO, en las dos direcciones', () => {
    // Hay una sola alarma por objeto: programar la de un motivo pisa la del otro.
    // Que gane el mas lejano significa que el otro llega tarde, y si el que llega
    // tarde es el vencimiento, es plata retenida de mas.
    //
    // Se afirma en LAS DOS direcciones a proposito. Con un solo caso, `Math.max`
    // pasaria la mitad de las veces segun cual motivo se haya puesto mas cerca.

    // El outbox atascado (cinco minutos) contra un vencimiento a media hora.
    expect(
      cuandoDespertar({
        ...nada,
        proximoVencimiento: EN_MEDIA_HORA,
        intentosDeLaCabeza: 50,
      }),
    ).toBe(AHORA + RETRASO_MAXIMO_MS)

    // Y al reves: un vencimiento en un minuto contra el mismo outbox atascado.
    expect(
      cuandoDespertar({
        ...nada,
        proximoVencimiento: '2026-08-17T12:01:00.000Z',
        intentosDeLaCabeza: 50,
      }),
    ).toBe(Date.parse('2026-08-17T12:01:00.000Z'))
  })

  it('lo ya vencido gana sobre el proximo vencimiento, no se suman', () => {
    // Si las dos ramas se acumularan, el `Math.min` daria lo mismo — pero la
    // intencion es otra: habiendo algo vencido, lo que viene despues no importa
    // todavia, porque la alarma ya esta puesta para lo antes posible.
    expect(
      cuandoDespertar({ ...nada, intentosDeLasVencidas: 0, proximoVencimiento: EN_MEDIA_HORA }),
    ).toBe(AHORA)
  })

  it('una liberacion que falla NO deja la alarma girando: el vencimiento tambien tiene backoff', () => {
    // ESTE es el defecto que la segunda vuelta de auditoria midio, y es de los que
    // nacen de un arreglo. La entrega anterior envolvio la liberacion en un
    // try/catch para que una reserva descuadrada no se llevara puesto al publicador.
    // Correcto — y con `hayVencidas: boolean`, la reserva seguia vencida y abierta,
    // asi que la alarma se reprogramaba para AHORA, se disparaba, volvia a fallar.
    //
    // Medido sobre workerd: ~185 disparos por segundo, sostenidos, sin un solo
    // error visible porque `alarm()` ya no tira. Un Durable Object despierto al
    // 100 % para siempre, que se factura por duracion, martillando D1 en cada vuelta.
    //
    // La forma correcta es la simetria: los dos motivos cuentan sus fracasos.
    expect(cuandoDespertar({ ...nada, intentosDeLasVencidas: 0 })).toBe(AHORA)
    expect(cuandoDespertar({ ...nada, intentosDeLasVencidas: 1 })).toBe(AHORA + 1_000)
    expect(cuandoDespertar({ ...nada, intentosDeLasVencidas: 4 })).toBe(AHORA + 8_000)
    expect(cuandoDespertar({ ...nada, intentosDeLasVencidas: 50 })).toBe(AHORA + RETRASO_MAXIMO_MS)

    // Y con el outbox tambien atascado, sigue ganando el mas cercano.
    expect(
      cuandoDespertar({ ...nada, intentosDeLasVencidas: 50, intentosDeLaCabeza: 1 }),
    ).toBe(AHORA + 1_000)
  })

  it('los dos motivos usan la MISMA escala de espera', () => {
    // Si uno de los dos se quedara sin backoff, vuelve el bucle por ese lado. Se
    // afirma la igualdad y no cada numero: lo que importa es que no puedan divergir.
    for (const i of [0, 1, 2, 5, 9, 12, 50]) {
      expect(cuandoDespertar({ ...nada, intentosDeLasVencidas: i })).toBe(
        cuandoDespertar({ ...nada, intentosDeLaCabeza: i }),
      )
    }
  })

  it('no lee el reloj: el instante entra por parametro', () => {
    // Toda la logica del vencimiento del proyecto funciona asi, y por eso se puede
    // probar un vencimiento a tres meses sin esperar tres meses.
    const otro = 0
    expect(cuandoDespertar({ ...nada, ahora: otro, intentosDeLasVencidas: 0 })).toBe(otro)
    expect(cuandoDespertar({ ...nada, ahora: otro, intentosDeLaCabeza: 2 })).toBe(otro + 2_000)
  })
})
