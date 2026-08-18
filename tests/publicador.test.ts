/**
 * El publicador, probado donde es barato: en Node, sin runtime.
 *
 * Lo que se prueba acá es la DECISION —a que tabla va cada fila, con que SQL, con
 * que valores y en que orden— y el ritmo de los reintentos. Que esas sentencias
 * entren de verdad en una D1, y que la segunda entrega del mismo evento no
 * duplique nada, se prueba en `pruebas-runtime/`, contra el esquema real.
 *
 * La division es la misma de siempre: acá corre la mutacion decenas de veces y no
 * puede pagar el arranque de workerd.
 */
import { describe, it, expect } from 'vitest'
import {
  type FilaDelOutbox,
  LOTE,
  PASADAS_MAXIMAS,
  RETRASO_MAXIMO_MS,
  TIPO_ASIENTO,
  destino,
  retrasoPorIntentos,
  sentencias,
} from '../src/billetera/publicador.js'

const asiento = {
  asiento_id: 'k1:cr',
  concepto: 'carga',
  monto: 100_000,
  bolsa: 'disponible',
  clave_idem: 'k1',
  correlacion_id: 'c1',
  asentado_en: '2026-08-17T12:00:00Z',
}

function filaDeAsiento(id: number): FilaDelOutbox {
  return {
    id,
    tipo: TIPO_ASIENTO,
    cuerpo: JSON.stringify(asiento),
    correlacion_id: asiento.correlacion_id,
    creado_en: asiento.asentado_en,
  }
}

function filaDeEvento(id: number, tipo = 'billetera.acreditada'): FilaDelOutbox {
  return {
    id,
    tipo,
    cuerpo: JSON.stringify({ billetera_id: 'b1', monto: 100_000 }),
    correlacion_id: 'c1',
    creado_en: '2026-08-17T12:00:00Z',
  }
}

describe('a que tabla de D1 va cada fila', () => {
  it('el asiento va al ledger y todo lo demas al registro de eventos', () => {
    expect(destino(TIPO_ASIENTO)).toBe('ledger_copia')
    expect(destino('billetera.acreditada')).toBe('eventos_billetera')
    expect(destino('billetera.reserva_liberada')).toBe('eventos_billetera')
    // Un tipo que todavia no existe tiene que ir a eventos, no romper: el
    // publicador no puede ser lo que impida agregar un evento nuevo.
    expect(destino('billetera.algo_que_no_inventamos_todavia')).toBe('eventos_billetera')
  })
})

describe('las sentencias para D1', () => {
  it('un asiento entra en ledger_copia con la billetera y el momento de copia', () => {
    const [s] = sentencias('b1', [filaDeAsiento(7)], '2026-08-17T12:00:05Z')

    expect(s?.sql).toContain('INSERT OR IGNORE INTO ledger_copia')
    // El orden importa: son parametros posicionales.
    expect(s?.valores).toEqual([
      'k1:cr',
      'b1',
      'carga',
      100_000,
      'disponible',
      'k1',
      'c1',
      '2026-08-17T12:00:00Z',
      '2026-08-17T12:00:05Z',
    ])
    // Tantos `?` como valores. Un desfasaje acá pone el monto en la columna de la
    // bolsa, y D1 lo acepta si los tipos coinciden por casualidad.
    expect((s?.sql ?? '').split('?').length - 1).toBe(s?.valores.length)
  })

  it('un evento entra en eventos_billetera con el id del outbox como clave', () => {
    const [s] = sentencias('b1', [filaDeEvento(9)], '2026-08-17T12:00:05Z')

    expect(s?.sql).toContain('INSERT OR IGNORE INTO eventos_billetera')
    expect(s?.valores).toEqual([
      'b1',
      // ESTE es el numero que hace que la segunda entrega no duplique: el id del
      // outbox del DO, que es un AUTOINCREMENT y no cambia entre reintentos.
      9,
      'billetera.acreditada',
      JSON.stringify({ billetera_id: 'b1', monto: 100_000 }),
      'c1',
      '2026-08-17T12:00:00Z',
      '2026-08-17T12:00:05Z',
    ])
    expect((s?.sql ?? '').split('?').length - 1).toBe(s?.valores.length)
  })

  it('nunca interpola: el cuerpo de un evento viaja como parametro', () => {
    // El cuerpo es texto que armo otra capa. Interpolarlo seria inyeccion de SQL
    // adentro del sistema que guarda la plata.
    const malicioso: FilaDelOutbox = {
      ...filaDeEvento(1),
      cuerpo: `'); DROP TABLE ledger_copia; --`,
    }
    const [s] = sentencias('b1', [malicioso], 'm')

    expect(s?.sql).not.toContain('DROP')
    expect(s?.valores).toContain(`'); DROP TABLE ledger_copia; --`)
  })

  it('respeta el orden de las filas: el id del outbox es el orden del dinero', () => {
    const salida = sentencias(
      'b1',
      [filaDeAsiento(1), filaDeEvento(2), filaDeAsiento(3)],
      'm',
    )
    expect(salida.map((s) => (s.sql.includes('ledger_copia') ? 'ledger' : 'evento'))).toEqual([
      'ledger',
      'evento',
      'ledger',
    ])
  })

  it('un cuerpo que dice ser un asiento y no lo es falla, y dice cual fila', () => {
    // Falla a los gritos en vez de mandar `undefined` a una columna NOT NULL: ese
    // error sale a kilometros del origen y con otro nombre.
    const roto: FilaDelOutbox = { ...filaDeAsiento(12), cuerpo: '{"asiento_id":"x"}' }
    expect(() => sentencias('b1', [roto], 'm')).toThrow(/fila 12 .* forma de asiento/)

    const noEsJson: FilaDelOutbox = { ...filaDeAsiento(13), cuerpo: 'no soy json' }
    expect(() => sentencias('b1', [noEsJson], 'm')).toThrow(/fila 13 .* no es JSON/)
  })

  it('un monto que llega como texto no pasa por asiento', () => {
    // STRICT esta del lado del DO. Del lado de D1 la columna tambien es INTEGER,
    // pero un '100000' de texto entra igual si nadie mira: sin esta comprobacion,
    // el ledger de reportes ordena '9' > '100000'.
    const roto: FilaDelOutbox = {
      ...filaDeAsiento(14),
      cuerpo: JSON.stringify({ ...asiento, monto: '100000' }),
    }
    expect(() => sentencias('b1', [roto], 'm')).toThrow(/forma de asiento/)
  })

  it('un lote vacio no produce sentencias', () => {
    expect(sentencias('b1', [], 'm')).toEqual([])
  })
})

describe('cuando volver a intentar', () => {
  it('sin fallos, YA: la copia no espera nada', () => {
    // Cero no es un caso borde: es el caso normal. Es lo que hace que la copia a
    // D1 salga en milisegundos sin que el que movio la plata pague esa latencia.
    expect(retrasoPorIntentos(0)).toBe(0)
    expect(retrasoPorIntentos(-1)).toBe(0)
  })

  it('duplica en cada fallo', () => {
    expect(retrasoPorIntentos(1)).toBe(1_000)
    expect(retrasoPorIntentos(2)).toBe(2_000)
    expect(retrasoPorIntentos(3)).toBe(4_000)
    expect(retrasoPorIntentos(4)).toBe(8_000)
  })

  it('y tiene techo, porque veinte fallos serian doce dias', () => {
    expect(retrasoPorIntentos(10)).toBe(RETRASO_MAXIMO_MS)
    expect(retrasoPorIntentos(100)).toBe(RETRASO_MAXIMO_MS)
    // Y no `Infinity`: `2 ** 1024` desborda, y `setAlarm(Infinity)` no es una
    // espera larga, es un error.
    expect(Number.isFinite(retrasoPorIntentos(5_000))).toBe(true)
    expect(retrasoPorIntentos(5_000)).toBe(RETRASO_MAXIMO_MS)
  })

  it('crece de forma monotona: nunca se espera menos despues de fallar mas', () => {
    for (let i = 0; i < 40; i += 1) {
      expect(retrasoPorIntentos(i + 1)).toBeGreaterThanOrEqual(retrasoPorIntentos(i))
    }
  })
})

describe('los topes del publicador', () => {
  it('son numeros positivos y finitos', () => {
    // Un `LOTE` en cero seria un publicador que lee cero filas para siempre, con
    // el outbox creciendo y todo en verde.
    for (const n of [LOTE, PASADAS_MAXIMAS, RETRASO_MAXIMO_MS]) {
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
    }
  })
})
