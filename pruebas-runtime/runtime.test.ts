/**
 * Lo que el Durable Object real puede hacer, comprobado sobre workerd.
 *
 * Por que esto existe como entrega propia, antes de escribir una linea del
 * Wallet DO: la entrega siguiente apoya la plata sobre tres mecanismos de
 * Cloudflare que el proyecto nunca ejecuto — el SQLite del DO, la alarma que
 * vence una reserva sola, y el rollback de la transaccion de storage que hace
 * posible la ley 5. La alternativa era fabricar un doble de la storage de
 * Cloudflare, y un doble mas permisivo que el original prueba el doble.
 *
 * QUE PRUEBAN Y QUE NO — leer esto antes de confiar en el numero de abajo.
 *
 * De las cincuenta y tres pruebas de este archivo:
 *
 *   · CUARENTA Y SEIS estan ancladas a codigo de `src/` y tienen una mutacion que
 *     las mata: las ocho del esquema (ejecutan la cadena que exporta
 *     `src/billetera/esquema.ts`, no una tabla de juguete), las tres de la
 *     transaccion, las siete del `BilleteraDO` por su metodo publico, las once de
 *     las reservas y la alarma, las quince del publicador, y las dos de `el Worker
 *     desplegado`.
 *
 *     (Este renglon quedo viejo tres veces seguidas, y `CLAUDE.md` lo declara la
 *     fuente. La cuenta que hay que hacer es la de los `it` por `describe`, no la
 *     suma de lo que uno se acuerda de haber agregado.)
 *   · CUATRO —las dos de aislamiento y las dos homonimas— prueban una convencion
 *     de este archivo y no una linea de produccion. Tres de las cuatro mueren por
 *     su propia asercion con una mutacion del arnes; la cuarta (`el estado
 *     sobrevive dentro de una misma prueba`) es el estado que las otras necesitan.
 *   · Las TRES restantes son SONDAS DE LA PLATAFORMA: las dos de la alarma y la de
 *     `transactionSync`. Verifican que Cloudflare se comporta como suponemos. Las
 *     de la alarma quedan como sondas incluso ahora que el vencimiento de reservas
 *     existe: miden que `setAlarm`/`getAlarm` hacen lo suyo, no nuestro codigo.
 *
 * LA LEY 5 YA TIENE ORACULO CONTRA EL METODO PUBLICO. La version anterior de este
 * encabezado decia, medido por una auditoria:
 *
 *   «Si `BilleteraDO` escribiera el asiento y el evento del outbox en dos `exec`
 *   sueltos, sin transaccion, las catorce pruebas de este archivo pasarian igual.»
 *
 * Era cierto: las pruebas llamaban a `ctx.storage.transaction()` directo, o sea
 * comprobaban que Cloudflare implementa transacciones. Ahora llaman al helper de
 * `src/`, y la mutacion «el asiento y el evento del outbox van en la MISMA
 * transaccion» le saca la transaccion al helper y muere.
 *
 * Eso ya no es cierto: `si falla EN EL MEDIO de escribir, no queda nada a medias`
 * llama a `acreditar()` del DO con una colision de PRIMARY KEY sembrada, o sea con
 * la caida ocurriendo DESPUES de que las bolsas y los totales se reescribieron. Sin
 * la transaccion, la plata de la carga anterior queda borrada. La mutacion que le
 * saca `enUnaTransaccion` al metodo publico muere ahi.
 *
 * Como se llego a esa prueba vale la pena contarlo: la primera version usaba un
 * debito sin saldo, y la mutacion SOBREVIVIO — el nucleo se queja antes de escribir
 * una sola fila, asi que probaba «no se escribe si no se empieza», que no es lo
 * mismo que «no queda nada a medias». Lo dijo el arnes de mutacion, no una
 * auditoria.
 */
import {
  type D1Migration,
  env,
  SELF,
  applyD1Migrations,
  runInDurableObject,
  runDurableObjectAlarm,
} from 'cloudflare:test'
import { describe, it, expect, beforeAll } from 'vitest'
import type { BilleteraDO, Entorno } from '../src/index.js'
import { ESQUEMA } from '../src/billetera/esquema.js'
import { guaranies } from '../src/dinero/monto.js'
import { enUnaTransaccion } from '../src/billetera/transaccion.js'
import { TIPO_ASIENTO } from '../src/billetera/publicador.js'

/**
 * El `env` de las pruebas se tipa con `Cloudflare.Env`, que lo GENERA wrangler
 * desde `wrangler.jsonc` (`worker-configuration.d.ts`, regenerado y comparado por
 * `check-entorno.mjs` en cada `npm run verificar`).
 *
 * La primera version de este archivo escribia `interface Env extends Entorno` y
 * el comentario decia que eso evitaba "un doble de la configuracion". Era falso,
 * y la auditoria lo midio en las dos direcciones: agregar una var a
 * `wrangler.jsonc` sin agregarla a `Entorno` no fallaba, y declarar en `Entorno`
 * un binding que `wrangler.jsonc` no tiene tampoco — quedaba `undefined` en
 * runtime, sin un solo ruido. `Entorno` ERA el doble, escrito a mano.
 *
 * La linea de abajo es lo que cierra la deriva: si `Entorno` promete algo que
 * `wrangler.jsonc` no declara, esto no compila.
 */
const _entornoNoPrometeDeMas: Entorno = {} as Cloudflare.Env
void _entornoNoPrometeDeMas

/**
 * Y la direccion contraria, que la segunda vuelta de auditoria encontro abierta:
 * la primera version tenia SOLO la linea de arriba, y el encabezado de
 * `check-entorno.mjs` enumeraba las dos direcciones como el defecto a cerrar.
 * Medido entonces: se agrego una var a `wrangler.jsonc`, se regeneraron los
 * tipos, y `Entorno` siguio sin ella con `tsc` en verde.
 *
 * Va sobre las CLAVES y no por asignabilidad mutua de tipos, y eso es un arreglo
 * de la tercera vuelta. La asignabilidad mutua obligaba a generar los tipos con
 * `--strict-vars=false`, porque `Entorno` declara `ENTORNO: string` y el generado
 * decia `ENTORNO: "staging"`. Y sin los literales, `wrangler types --env staging`
 * y `--env produccion` producen el archivo byte a byte identico: `check-entorno.mjs`
 * quedaba CIEGO al entorno. Un arreglo aflojando otra comprobacion.
 *
 * Comparar claves cierra «falta un binding» sin pedirle nada a los tipos de valor,
 * asi que los literales vuelven y el otro oraculo recupera la vista.
 */
type BindingsQueFaltanEnEntorno = Exclude<keyof Cloudflare.Env, keyof Entorno>
const _entornoNoPrometeDeMenos: BindingsQueFaltanEnEntorno extends never ? true : false = true
void _entornoNoPrometeDeMenos

/**
 * Y que ningun binding este declarado como `any`.
 *
 * `any` es asignable en las dos direcciones, asi que se cuela por las dos lineas
 * de arriba. Y el final es el mismo que el defecto original: `env.CORE.loQueSea()`
 * compila y explota en runtime, «sin un solo ruido».
 *
 * El truco `0 extends 1 & T[K]` es la unica forma de detectar `any` en TypeScript:
 * `1 & any` es `any`, y `0 extends any` es cierto, mientras que para cualquier
 * otro tipo la interseccion no absorbe. Es opaco y por eso lleva este parrafo: sin
 * el, el proximo que lo lea lo borra.
 */
type SinAny<T> = { [K in keyof T]: 0 extends 1 & T[K] ? never : T[K] }
const _entornoSinAny: SinAny<Entorno> = {} as Entorno
void _entornoSinAny

/**
 * Una billetera por prueba, con el nombre derivado de `task.fullName`.
 *
 * No es cosmetica. Medido: en esta version del pool no hay `isolatedStorage` y el
 * storage NO se resetea entre pruebas del mismo archivo — dos `it` que compartan
 * nombre de Durable Object comparten tablas y filas. Hoy eso se nota porque las
 * pruebas hacen `CREATE TABLE` y la segunda choca; en cuanto el esquema lo cree
 * el constructor del DO, ese aviso desaparece y una prueba de saldo pasaria por
 * plata que dejo otra.
 *
 * Va `task.fullName` y NO `task.name`, y esto es un arreglo de la segunda vuelta
 * de auditoria: `task.name` es solo el texto del `it`, sin el `describe`. Dos
 * pruebas con el mismo texto en dos `describe` distintos daban el MISMO id de
 * Durable Object — el aislamiento no aislaba, con un comentario aca diciendo que
 * si. `task.fullName` incluye el camino completo.
 *
 * Dos `describe` de este archivo tienen una prueba con el mismo texto a proposito:
 * son el oraculo de esto, y la mutacion que vuelve a `prueba.name` las mata.
 */
function billetera(prueba: { readonly name: string; readonly fullName: string }) {
  // Recibe la prueba entera y no un texto ya elegido, a proposito: asi hay UN
  // solo lugar donde se decide que campo usar, y por lo tanto un solo lugar que
  // la mutacion tiene que romper. Con el nombre resuelto en cada sitio de
  // llamada, `String.replace` cambiaba el primero de los doce y los otros once
  // quedaban sin mutar, asi que la mutacion sobrevivia.
  return env.BILLETERA.get(env.BILLETERA.idFromName(prueba.fullName))
}

/**
 * Las migraciones de D1 llegan como un binding de miniflare que pone
 * `vitest.runtime.config.ts` leyendo la MISMA carpeta que despliega wrangler
 * (`check-runtime.mjs` comprueba que sean la misma).
 *
 * Se lee con un cast local y no augmentando `Cloudflare.Env`, a proposito: ese
 * tipo lo genera wrangler desde `wrangler.jsonc`, y los tres guardas de deriva de
 * arriba comparan sus claves contra `Entorno`. Meter ahi un binding que solo existe
 * en las pruebas obligaria a aflojar los guardas — arreglar el arnes rompiendo el
 * oraculo, que es el patron que este proyecto ya cazo dos veces.
 */
const MIGRACIONES = (env as unknown as { MIGRACIONES: D1Migration[] }).MIGRACIONES

/**
 * D1 se migra una vez para todo el archivo.
 *
 * Sin esto, `ledger_copia` y `eventos_billetera` no existen, el publicador falla en
 * silencio —los captura, cuenta el intento y reprograma— y las pruebas de las
 * alarmas pasarian igual con el outbox tapado. Un arnes que aprueba con la mitad
 * del sistema ausente es peor que uno que no existe.
 */
beforeAll(async () => {
  // Que las migraciones lleguen de verdad. Si el binding faltara, `applyD1Migrations`
  // con una lista vacia no crea nada y no se queja: el mismo silencio de arriba.
  expect(Array.isArray(MIGRACIONES)).toBe(true)
  expect(MIGRACIONES.length).toBeGreaterThan(0)
  await applyD1Migrations(env.CORE, MIGRACIONES)
})

/**
 * Un instante futuro para programar una alarma.
 *
 * Esto NO puede ser una fecha absoluta cableada, y la leccion salio caro: la
 * version anterior usaba `Date.parse('2026-08-17T15:00:00.000Z')`. Paso a las 13:53
 * UTC del 17 de agosto y fallo a las 15:11 UTC del mismo dia, porque a partir de
 * las 15:00 esa fecha quedo en el PASADO y workerd normaliza una alarma vencida
 * al instante actual. El mismo commit, la misma maquina, dos veredictos segun la
 * hora — el defecto n.º 6 de la Fase 0 adentro de la entrega que existe para
 * cazarlo.
 *
 * Treinta minutos es el plazo real del plan maestro para una reserva sin
 * confirmar. Lo que se afirma es la igualdad contra el valor que se programo, asi
 * que la prueba sigue siendo exacta sin depender del calendario.
 */
function dentroDeMediaHora(): number {
  return Date.now() + 30 * 60 * 1000
}

/**
 * Vacia el outbox de una billetera y deja la alarma coherente con lo que quedo.
 *
 * Hace falta en cualquier prueba que mire la alarma, y la razon es un cambio real
 * de esta entrega: desde que el publicador existe, TODA operacion deja filas
 * pendientes y programa la alarma para "ahora". Una prueba que afirme sobre la
 * alarma sin haber vaciado el outbox esta afirmando sobre una carrera.
 *
 * Se drena invocando `alarm()`, que es lo que Cloudflare va a invocar: publica,
 * libera lo vencido y reprograma. Si se llamara a `publicar()` a secas, la alarma
 * quedaria apuntando a donde la dejo la ultima operacion.
 *
 * El tope de vueltas no es cosmetico: si el publicador se atascara —una fila que
 * no puede salir nunca— esto seria un `while (true)` y la prueba colgaria el CI en
 * vez de fallar.
 */
async function drenar(oreja: ReturnType<typeof billetera>) {
  for (let vuelta = 0; vuelta < 5; vuelta += 1) {
    await runInDurableObject(oreja, async (instancia) => {
      await instancia.alarm?.()
    })
    const d = await oreja.diagnostico()
    if (d.outbox.pendientes === 0) return d
  }
  throw new Error('el outbox no se vacio en cinco vueltas de la alarma')
}

/** Crea el esquema REAL del BilleteraDO. No una tabla de juguete: la cadena que
 *  exporta `src/billetera/esquema.ts` y que el Durable Object va a ejecutar. */
function crearEsquema(ctx: { storage: { sql: { exec: (s: string) => unknown } } }) {
  for (const sentencia of ESQUEMA) ctx.storage.sql.exec(sentencia)
}

describe('el esquema real del Durable Object', () => {
  it('se crea entero, y dos veces seguidas no rompe', async ({ task }) => {
    // Lo segundo importa: el constructor del DO lo va a ejecutar en cada
    // instanciacion, no solo la primera. De ahi los `IF NOT EXISTS`.
    const tablas = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      crearEsquema(ctx)
      return [
        ...ctx.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ),
      ].map((f) => f.name)
    })

    expect(tablas).toEqual([
      'aplicadas',
      'asientos',
      'bolsas',
      'outbox',
      'reservas',
      'tomas',
      'totales_ledger',
    ])
  })

  it('aplica STRICT: un guarani de texto no entra en la columna del monto', async ({ task }) => {
    // Sin STRICT, un '100000' de TEXTO entra y ordena como texto: '9' > '100000'.
    // La restriccion tiene que estar adentro de la unica puerta al dinero.
    //
    // Se afirma sobre el MENSAJE y hay control positivo, porque «hubo un error» lo
    // cumple tambien un INSERT a una columna que no existe.
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)

      let error: string | null = null
      try {
        ctx.storage.sql.exec(
          "INSERT INTO bolsas (tipo, monto, origen) VALUES ('disponible', 'cien mil', 'x')",
        )
      } catch (e) {
        error = (e as Error).message
      }

      ctx.storage.sql.exec(
        "INSERT INTO bolsas (tipo, monto, origen) VALUES ('disponible', 100000, 'x')",
      )

      return {
        error,
        filas: [...ctx.storage.sql.exec<{ monto: number }>('SELECT monto FROM bolsas')],
      }
    })

    expect(r.error).toMatch(/INTEGER/i)
    expect(r.filas).toEqual([{ monto: 100000 }])
  })

  it('aplica el CHECK: una bolsa inventada no entra', async ({ task }) => {
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)

      let error: string | null = null
      try {
        ctx.storage.sql.exec(
          "INSERT INTO bolsas (tipo, monto, origen) VALUES ('inventada', 1, 'x')",
        )
      } catch (e) {
        error = (e as Error).message
      }

      ctx.storage.sql.exec("INSERT INTO bolsas (tipo, monto, origen) VALUES ('retenido', 1, 'x')")

      return {
        error,
        filas: [...ctx.storage.sql.exec<{ tipo: string }>('SELECT tipo FROM bolsas')],
      }
    })

    expect(r.error).toMatch(/CHECK/i)
    expect(r.filas).toEqual([{ tipo: 'retenido' }])
  })

  it('una bolsa en cero o negativa no entra', async ({ task }) => {
    // Una bolsa en cero no es una bolsa: es una fila que ensucia la precedencia.
    // Y una en negativo es plata inventada.
    const errores = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      const intentar = (monto: number) => {
        try {
          ctx.storage.sql.exec(
            `INSERT INTO bolsas (tipo, monto, origen) VALUES ('disponible', ${monto}, 'x')`,
          )
          return null
        } catch (e) {
          return (e as Error).message
        }
      }
      return { cero: intentar(0), negativa: intentar(-1), positiva: intentar(1) }
    })

    expect(errores.cero).toMatch(/CHECK/i)
    expect(errores.negativa).toMatch(/CHECK/i)
    expect(errores.positiva).toBeNull()
  })

  it('un vencimiento mal escrito no entra en la base', async ({ task }) => {
    // La contracara de `dinero/momento.ts`, del lado de adentro. Una auditoria
    // pregunto por que el instante se revisaba solo en TypeScript cuando el
    // encabezado de este esquema dice que la restriccion «tiene que estar del lado
    // de adentro de la unica puerta al dinero».
    //
    // Importa porque `reservasVencidas` compara `vence_en <= momento` en SQL puro,
    // texto contra texto: con anchos distintos, «vencida» y «vigente» dejan de
    // significar lo que dicen.
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      const intentar = (sql: string, ...v: unknown[]) => {
        try {
          ctx.storage.sql.exec(sql, ...v)
          return null
        } catch (e) {
          return (e as Error).message
        }
      }
      const bolsa = (vence: string | null) =>
        intentar(
          'INSERT INTO bolsas (tipo, monto, vence_en, origen, restringida_a) VALUES (?, ?, ?, ?, ?)',
          'credito_promocion',
          1_000,
          vence,
          'promo',
          null,
        )

      return {
        // La forma buena entra.
        buena: bolsa('2026-12-31T00:00:00.000Z'),
        // Sin vencimiento tambien: una bolsa eterna es legitima.
        sinVencimiento: bolsa(null),
        // La forma corta NO, que es el caso que la segunda vuelta midio.
        corta: bolsa('2026-12-31T00:00:00Z'),
        // Ni el huso.
        conHuso: bolsa('2026-12-31T00:00:00.000-03:00'),
        // Ni cualquier cosa.
        basura: bolsa('cuando sea'),
        // Y esta es la que el ancho SOLO no agarra: veinticuatro caracteres, cada
        // separador en su lugar, y letras donde van los digitos. La pidio el arnes
        // de mutacion — sin la clase negada del CHECK, entraba.
        letras: bolsa('abcd-ef-ghTij:kl:mn.opqZ'),
        // Y en `reservas`, que es la que se compara en SQL.
        reserva: intentar(
          'INSERT INTO reservas (reserva_id, consumido, vence_en, estado) VALUES (?, ?, ?, ?)',
          'r1',
          0,
          '2026-12-31T00:00:00Z',
          'abierta',
        ),
      }
    })

    expect(r.buena).toBeNull()
    expect(r.sinVencimiento).toBeNull()
    expect(r.corta).toMatch(/CHECK/i)
    expect(r.conHuso).toMatch(/CHECK/i)
    expect(r.basura).toMatch(/CHECK/i)
    expect(r.letras).toMatch(/CHECK/i)
    expect(r.reserva).toMatch(/CHECK/i)
  })

  it('un asiento no se edita ni se borra: ley 2, hecha cumplir', async ({ task }) => {
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      ctx.storage.sql.exec(
        `INSERT INTO asientos (asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en)
         VALUES ('a1', 'compra', -50000, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00.000Z')`,
      )

      const intentar = (sql: string) => {
        try {
          ctx.storage.sql.exec(sql)
          return null
        } catch (e) {
          return (e as Error).message
        }
      }

      return {
        editar: intentar("UPDATE asientos SET monto = 0 WHERE asiento_id = 'a1'"),
        borrar: intentar("DELETE FROM asientos WHERE asiento_id = 'a1'"),
        quedan: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')],
      }
    })

    expect(r.editar).toMatch(/no se edita/)
    expect(r.borrar).toMatch(/no se borra/)
    expect(r.quedan).toEqual([{ n: 1 }])
  })

  it('el mismo asiento_id no entra dos veces: un duplicado es un pago doble', async ({ task }) => {
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      const insertar = () => {
        try {
          ctx.storage.sql.exec(
            `INSERT INTO asientos (asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en)
             VALUES ('a1', 'compra', -1, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00.000Z')`,
          )
          return null
        } catch (e) {
          return (e as Error).message
        }
      }
      return { primero: insertar(), segundo: insertar() }
    })

    expect(r.primero).toBeNull()
    expect(r.segundo).not.toBeNull()
  })

  it('consumido no puede superar el total de las tomas de la reserva', async ({ task }) => {
    // LA COTA. `Reserva.consumido` existia declarado y nada lo acotaba: se podia
    // consumir mas de lo reservado, y el remanente que vuelve al usuario habria
    // salido negativo. Va como trigger porque un CHECK no puede mirar otra tabla.
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      ctx.storage.sql.exec(
        `INSERT INTO reservas (reserva_id, consumido, vence_en, estado)
         VALUES ('r1', 0, '2026-08-17T00:30:00.000Z', 'abierta')`,
      )
      ctx.storage.sql.exec(
        `INSERT INTO tomas (reserva_id, orden, tipo, monto, origen)
         VALUES ('r1', 0, 'disponible', 30000, 'x')`,
      )

      const consumir = (monto: number) => {
        try {
          ctx.storage.sql.exec(`UPDATE reservas SET consumido = ${monto} WHERE reserva_id = 'r1'`)
          return null
        } catch (e) {
          return (e as Error).message
        }
      }

      return {
        parcial: consumir(10000),
        exacto: consumir(30000),
        pasado: consumir(30001),
        final: [...ctx.storage.sql.exec<{ consumido: number }>('SELECT consumido FROM reservas')],
      }
    })

    // Consumir parte, y consumir el total, son los dos legitimos.
    expect(r.parcial).toBeNull()
    expect(r.exacto).toBeNull()
    // Un guarani mas que el total, no.
    expect(r.pasado).toMatch(/consumido no puede superar/)
    // Y el rechazo no dejo el valor a medio escribir.
    expect(r.final).toEqual([{ consumido: 30000 }])
  })
})

describe('la transaccion de storage', () => {
  it('deshace TODA la escritura cuando algo falla en el medio', async ({ task }) => {
    // La ley 5 pide que el evento del outbox y el asiento se escriban en la
    // misma transaccion. Esta sonda mide que el mecanismo cumple: una caida en
    // el medio no deja ni uno de los dos. Lo que NO mide —y esta escrito arriba—
    // es que nuestro codigo lo use.
    const quedaron = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)

      try {
        // Llama al helper de `src/`, no a la API de Cloudflare directo. Es lo que
        // hace que exista UNA linea que romper: hay una mutacion que le saca la
        // transaccion al helper y tiene que morir.
        enUnaTransaccion(ctx, () => {
          ctx.storage.sql.exec(
            `INSERT INTO asientos (asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en)
             VALUES ('a1', 'compra', -1, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00.000Z')`,
          )
          throw new Error('caida inyectada entre el asiento y el evento')
        })
      } catch {
        /* la caida es a proposito */
      }

      return {
        asientos: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')],
        outbox: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')],
      }
    })

    expect(quedaron.asientos).toEqual([{ n: 0 }])
    expect(quedaron.outbox).toEqual([{ n: 0 }])
  })

  it('confirma las dos escrituras cuando no falla nada', async ({ task }) => {
    // El par de la sonda de arriba. Una prueba de rollback sola pasaria igual si
    // la transaccion nunca escribiera nada: hay que verificar tambien que el
    // camino sano SI persiste, o no se distingue "deshizo" de "no hizo".
    const quedaron = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)

      enUnaTransaccion(ctx, () => {
        ctx.storage.sql.exec(
          `INSERT INTO asientos (asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en)
           VALUES ('a1', 'compra', -1, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00.000Z')`,
        )
        ctx.storage.sql.exec(
          `INSERT INTO outbox (tipo, cuerpo, correlacion_id, creado_en)
           VALUES ('billetera.debitada', '{}', 'c1', '2026-08-17T00:00:00.000Z')`,
        )
      })

      return {
        asientos: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')],
        outbox: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')],
      }
    })

    expect(quedaron.asientos).toEqual([{ n: 1 }])
    expect(quedaron.outbox).toEqual([{ n: 1 }])
  })

  it('el helper devuelve lo que calculo adentro de la transaccion', async ({ task }) => {
    // Que devuelva el valor no es cosmetico: sin eso, quien llama tiene que volver
    // a consultar despues del commit para saber que quedo, y esa segunda consulta
    // ya esta fuera de la transaccion.
    const saldo = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      return enUnaTransaccion(ctx, () => {
        ctx.storage.sql.exec(
          "INSERT INTO bolsas (tipo, monto, origen) VALUES ('disponible', 100000, 'carga')",
        )
        return [
          ...ctx.storage.sql.exec<{ total: number }>('SELECT SUM(monto) AS total FROM bolsas'),
        ][0]?.total
      })
    })

    expect(saldo).toBe(100000)
  })

  it('transactionSync tambien deshace, asi que la eleccion es nuestra y no forzada', async ({
    task,
  }) => {
    // La auditoria pregunto por que el arnes fija `transaction()` cuando para un
    // DO con SQLite existe `transactionSync()`. La respuesta honesta era que
    // nadie lo habia medido. Se mide: las dos deshacen. La entrega siguiente
    // elige por otro motivo (la sincrona no puede envolver un `await`, y eso es
    // una VENTAJA: impide que una transaccion abarque I/O externo — durante el
    // cual, segun la documentacion de Cloudflare, la compuerta de entrada se ABRE
    // y otra operacion puede entrar a leer un estado a medio cambiar), no porque
    // el arnes le haya cerrado la puerta.
    // Usa una tabla propia con nombre propio: desde que el constructor del DO
    // crea el esquema real, una sonda que invente una tabla `asientos` choca con
    // la de verdad. Es una buena señal — significa que el esquema ya esta ahi
    // antes de que nadie lo pida.
    const quedaron = await runInDurableObject(billetera(task), (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE sonda_sync (id TEXT PRIMARY KEY) STRICT')

      try {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec("INSERT INTO sonda_sync (id) VALUES ('a1')")
          throw new Error('caida inyectada')
        })
      } catch {
        /* a proposito */
      }

      return [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM sonda_sync')]
    })

    expect(quedaron).toEqual([{ n: 0 }])
  })
})

describe('la alarma del Durable Object', () => {
  it('se programa, se lee y se puede cancelar', async ({ task }) => {
    // El plan maestro dice que una reserva sin confirmar vence sola, por la
    // alarma del propio DO, sin cron ni barrido. Esto es el mecanismo.
    const vencimiento = dentroDeMediaHora()

    await runInDurableObject(billetera(task), async (_do, ctx) => {
      expect(await ctx.storage.getAlarm()).toBeNull()

      await ctx.storage.setAlarm(vencimiento)
      expect(await ctx.storage.getAlarm()).toBe(vencimiento)

      // Reprogramar pisa: hay UNA alarma por objeto, no una cola. La entrega
      // siguiente tiene que reprogramarla al proximo vencimiento pendiente, y
      // esta linea es la razon por la que eso no es opcional.
      const masTemprano = vencimiento - 60_000
      await ctx.storage.setAlarm(masTemprano)
      expect(await ctx.storage.getAlarm()).toBe(masTemprano)

      await ctx.storage.deleteAlarm()
      expect(await ctx.storage.getAlarm()).toBeNull()
    })
  })

  it('el disparador distingue "habia alarma" de "no habia"', async ({ task }) => {
    // Esta prueba se escribio afirmando otra cosa: que `runDurableObjectAlarm`
    // iba a devolver `false` porque `BilleteraDO` todavia no implementa
    // `alarm()`. Devolvio `true`. El valor no reporta si hay handler, reporta si
    // habia una alarma programada y la disparo.
    //
    // Se deja escrito porque es justo la clase de suposicion que la entrega
    // siguiente iba a heredar: "la alarma no salto" y "el DO no tiene handler"
    // son dos cosas distintas, y este helper solo sabe de la primera. Confundir
    // las dos habria hecho pasar una prueba de vencimiento de reservas con el
    // metodo desconectado.
    const oreja = billetera(task)

    // Sin alarma programada: no hay nada que disparar.
    expect(await runDurableObjectAlarm(oreja)).toBe(false)

    await runInDurableObject(oreja, async (_do, ctx) => {
      await ctx.storage.setAlarm(dentroDeMediaHora())
    })

    // Con alarma programada: la dispara, y devuelve que la disparo.
    expect(await runDurableObjectAlarm(oreja)).toBe(true)

    // Y despues de dispararse queda consumida — una alarma no se repite sola.
    // Por eso el vencimiento de reservas tiene que reprogramarla explicitamente
    // al proximo pendiente, y no alcanza con programarla una vez.
    await runInDurableObject(oreja, async (_do, ctx) => {
      expect(await ctx.storage.getAlarm()).toBeNull()
    })
    expect(await runDurableObjectAlarm(oreja)).toBe(false)
  })
})

describe('el aislamiento entre pruebas', () => {
  // Estas existen porque el storage NO se resetea entre pruebas del mismo
  // archivo, y en esta version del pool no hay ninguna opcion que lo haga. El
  // aislamiento es una convencion —el nombre del Durable Object— y una
  // convencion sin oraculo se rompe sola. Estas son el oraculo.

  it('el estado sobrevive dentro de una misma prueba', async ({ task }) => {
    const oreja = billetera(task)

    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE marca (n INTEGER NOT NULL) STRICT')
      ctx.storage.sql.exec('INSERT INTO marca (n) VALUES (1)')
    })

    // Segunda invocacion, misma billetera: tiene que ver lo de antes. Es lo que
    // hace que un DO sirva para guardar plata.
    const filas = await runInDurableObject(oreja, (_do, ctx) => [
      ...ctx.storage.sql.exec<{ n: number }>('SELECT n FROM marca'),
    ])

    expect(filas).toEqual([{ n: 1 }])
  })

  it('y NO se filtra a otra prueba, porque el nombre lo separa', async ({ task }) => {
    // Si el nombre no separara, la tabla `marca` de la prueba de arriba estaria
    // visible aca y esto fallaria.
    const tablas = await runInDurableObject(billetera(task), (_do, ctx) => [
      ...ctx.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'marca'",
      ),
    ])

    expect(tablas).toEqual([{ n: 0 }])
  })
})

/**
 * Dos `describe` con una prueba de TEXTO IDENTICO a proposito. Son el oraculo de
 * que el aislamiento use el camino completo y no solo el texto del `it`: con
 * `task.name` los dos daban el mismo id de Durable Object y el segundo veia la
 * tabla del primero. La mutacion `prueba.fullName` -> `prueba.name` muere aca, y
 * sin este par no moriria en ningun lado.
 *
 * Son SIMETRICAS —cada una mira antes de escribir— y eso es un arreglo de la
 * tercera vuelta de auditoria. La version anterior era A escribe / B comprueba, o
 * sea que sólo detectaba la colision si A corria primero: invirtiendo los dos
 * `describe`, la mutacion sobrevivia con la suite en verde. Un oraculo que depende
 * del orden de las pruebas es una convencion, no un oraculo.
 *
 * Lo que sigue siendo convencion, y no encontre como blindar: que el texto de los
 * dos `it` sea identico. Si alguien renombra uno «para que se entienda cual es
 * cual», el par deja de ser homonimo y el oraculo se apaga en silencio. De ahi que
 * este parrafo este arriba de los dos, y no de uno.
 */
function comprobarQueNadieEscribioAca(sufijo: 'A' | 'B') {
  return async ({ task }: { task: { readonly name: string; readonly fullName: string } }) => {
    const oreja = billetera(task)

    // Nadie mas tiene que haber escrito en MI Durable Object. Mirar antes de
    // escribir es lo que hace que el par no dependa de cual corre primero.
    const ajenas = await runInDurableObject(oreja, (_do, ctx) => [
      ...ctx.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'homonima_%'",
      ),
    ])
    expect(ajenas).toEqual([{ n: 0 }])

    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec(`CREATE TABLE homonima_${sufijo} (n INTEGER NOT NULL) STRICT`)
    })
  }
}

describe('dos pruebas con el mismo texto · grupo A', () => {
  it('no comparten Durable Object', comprobarQueNadieEscribioAca('A'))
})

describe('dos pruebas con el mismo texto · grupo B', () => {
  it('no comparten Durable Object', comprobarQueNadieEscribioAca('B'))
})

describe('el BilleteraDO, por su metodo publico', () => {
  // Estas son las que cierran la ley 5 de punta a punta. Las del esquema y las de
  // la transaccion prueban las piezas; estas prueban que el metodo que mueve la
  // plata las USA. Sin ellas, el DO podia escribir el asiento y el evento en dos
  // `exec` sueltos y todo lo demas seguia en verde.

  const op = (clave: string) => ({
    clave_idem: clave,
    correlacion_id: 'c1',
    momento: '2026-08-17T12:00:00.000Z',
  })

  it('acreditar deja el asiento, la bolsa y el evento del outbox', async ({ task }) => {
    const oreja = billetera(task)

    const r = await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })

    expect(r.repetida).toBe(false)
    expect(r.valor.saldo_retirable).toBe(100_000)

    const quedo = await runInDurableObject(oreja, (_do, ctx) => ({
      bolsas: [...ctx.storage.sql.exec<{ n: number; total: number }>(
        'SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS total FROM bolsas',
      )],
      asientos: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')],
      outbox: [...ctx.storage.sql.exec<{ tipo: string }>(
        'SELECT tipo FROM outbox ORDER BY id',
      )],
      totales: [...ctx.storage.sql.exec<{ bolsa: string; total: number }>(
        'SELECT bolsa, total FROM totales_ledger',
      )],
    }))

    expect(quedo.bolsas).toEqual([{ n: 1, total: 100_000 }])
    expect(quedo.asientos).toEqual([{ n: 1 }])
    // Ley 5: el evento esta, y llego junto con el asiento. Son DOS filas y no una:
    // el asiento tambien sale por el outbox, porque `ledger_copia` de D1 se llena
    // por ahi y no por un segundo camino que alguien tenga que acordarse de usar.
    expect(quedo.outbox.map((f) => f.tipo)).toEqual([TIPO_ASIENTO, 'billetera.acreditada'])
    expect(quedo.totales).toEqual([{ bolsa: 'disponible', total: 100_000 }])
  })

  it('la misma clave de idempotencia no paga dos veces', async ({ task }) => {
    const oreja = billetera(task)
    const entrada = {
      monto: guaranies(100_000),
      bolsa: 'disponible' as const,
      concepto: 'carga',
      origen: 'dpago',
    }

    const primera = await oreja.acreditar(op('k1'), entrada)
    const segunda = await oreja.acreditar(op('k1'), entrada)

    expect(primera.repetida).toBe(false)
    expect(segunda.repetida).toBe(true)
    // Y devuelve lo MISMO que la primera vez, no un valor nuevo.
    expect(segunda.valor).toEqual(primera.valor)

    const quedo = await runInDurableObject(oreja, (_do, ctx) => ({
      asientos: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')],
      outbox: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')],
      total: [...ctx.storage.sql.exec<{ t: number }>('SELECT COALESCE(SUM(monto), 0) AS t FROM bolsas')],
    }))

    // Un asiento, su copia y su evento: una vez la plata. Un cuarto renglon acá
    // seria un consumidor cobrando dos veces (ley 6: por eso ademas es idempotente).
    expect(quedo.asientos).toEqual([{ n: 1 }])
    expect(quedo.outbox).toEqual([{ n: 2 }])
    expect(quedo.total).toEqual([{ t: 100_000 }])
  })

  it('una operacion que falla no deja NADA: ni asiento, ni evento, ni saldo', async ({ task }) => {
    // ESTA es la prueba de la ley 5 contra el metodo publico. No hace falta
    // inyectar una caida sintetica: un debito sin saldo tira desde adentro de la
    // transaccion, que es exactamente la forma que tomaria una caida real entre
    // la escritura del asiento y la del evento.
    //
    // Si `aplicar()` escribiera fuera de la transaccion, acá quedarian filas.
    const oreja = billetera(task)
    await oreja.acreditar(op('k1'), {
      monto: guaranies(50_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })

    const antes = await runInDurableObject(oreja, (_do, ctx) => ({
      asientos: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')][0]?.n,
      outbox: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')][0]?.n,
    }))

    // Se atrapa con try/catch y no con `.rejects`. Medido: con `.rejects`, el
    // stub del Durable Object dejaba una promesa rechazada sin manejar, vitest la
    // reportaba como «Unhandled Rejection» y salia con codigo 1 — con las 24
    // pruebas en verde arriba. Un veredicto verde que no lo era.
    let error: unknown = null
    try {
      await oreja.debitar(op('k2'), { monto: guaranies(999_999), concepto: 'compra' })
    } catch (e) {
      error = e
    }
    expect(String(error)).toMatch(/saldo insuficiente/)

    const despues = await runInDurableObject(oreja, (_do, ctx) => ({
      asientos: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')][0]?.n,
      outbox: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')][0]?.n,
      total: [...ctx.storage.sql.exec<{ t: number }>('SELECT COALESCE(SUM(monto), 0) AS t FROM bolsas')][0]?.t,
      aplicadas: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM aplicadas')][0]?.n,
    }))

    expect(despues.asientos).toBe(antes.asientos)
    expect(despues.outbox).toBe(antes.outbox)
    expect(despues.total).toBe(50_000)
    // Y la clave de idempotencia del intento fallido NO quedo marcada: si
    // quedara, el reintento legitimo devolveria "ya aplicada" sin haber aplicado
    // nada. Es la forma mas silenciosa de perder un pago.
    expect(despues.aplicadas).toBe(1)
  })

  it('si falla EN EL MEDIO de escribir, no queda nada a medias', async ({ task }) => {
    // La prueba de arriba no alcanzaba, y lo dijo el arnes de mutacion: sacarle la
    // transaccion a `aplicar()` la dejaba pasar igual. El motivo es que un debito
    // sin saldo tira ANTES de escribir una sola fila — el nucleo se queja y no se
    // llega a `guardarDelta`. O sea que probaba «no se escribe si no se empieza»,
    // que no es lo mismo que «no queda nada a medias».
    //
    // Acá la caida ocurre DESPUES de que empezo a escribir: se siembra un asiento
    // con el id que la operacion va a producir, asi que el INSERT de los asientos
    // viola la PRIMARY KEY — y para ese momento las bolsas y los totales YA se
    // reescribieron. Es la forma exacta que tomaria una caida real en el medio.
    const oreja = billetera(task)
    await oreja.acreditar(op('k1'), {
      monto: guaranies(50_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })

    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec(
        `INSERT INTO asientos (asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en)
         VALUES ('k9:cr', 'sembrado', 1, 'disponible', 'otra', 'c0', '2026-08-17T00:00:00.000Z')`,
      )
    })

    let error: unknown = null
    try {
      await oreja.acreditar(op('k9'), {
        monto: guaranies(70_000),
        bolsa: 'disponible',
        concepto: 'carga',
        origen: 'dpago',
      })
    } catch (e) {
      error = e
    }
    expect(error).not.toBeNull()

    const quedo = await runInDurableObject(oreja, (_do, ctx) => ({
      total: [...ctx.storage.sql.exec<{ t: number }>(
        'SELECT COALESCE(SUM(monto), 0) AS t FROM bolsas',
      )][0]?.t,
      outbox: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')][0]?.n,
      totales: [...ctx.storage.sql.exec<{ t: number }>(
        "SELECT total AS t FROM totales_ledger WHERE bolsa = 'disponible'",
      )][0]?.t,
    }))

    // Las bolsas y los totales volvieron a donde estaban. Sin la transaccion, el
    // `DELETE FROM bolsas` y los INSERT ya habrian quedado firmes y acá veriamos
    // 70.000 en vez de 50.000: la plata de la carga anterior, borrada.
    expect(quedo.total).toBe(50_000)
    expect(quedo.totales).toBe(50_000)
    // Las dos filas de la carga que SI funciono —su asiento y su evento— y ninguna
    // de la que fallo.
    expect(quedo.outbox).toBe(2)
  })

  it('la reconciliacion nota si el acumulado se corrompe por su cuenta', async ({ task }) => {
    // `verificarInvariantes` compara las bolsas contra `totales_ledger`, que es un
    // cache. Si ese cache se corrompiera solo, la comparacion no lo veria: los dos
    // lados mentirian igual. Esto es lo unico que puede notarlo, y por eso tiene
    // que poder decir que NO.
    const oreja = billetera(task)
    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })

    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })

    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec("UPDATE totales_ledger SET total = 999 WHERE bolsa = 'disponible'")
    })

    const r = await oreja.reconciliar()
    expect(r.ok).toBe(false)
    expect(r.diferencias.join(' ')).toMatch(/disponible.*100000.*999/)
  })

  it('el debito consume, asienta y avisa, y el ledger sigue cuadrando', async ({ task }) => {
    const oreja = billetera(task)
    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await oreja.debitar(op('k2'), { monto: guaranies(30_000), concepto: 'compra' })

    const saldo = await oreja.saldo()
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(70_000)
    expect(saldo.asientos).toBe(2)

    // La reconciliacion exhaustiva: la suma de los asientos de verdad contra el
    // acumulado que `verificarInvariantes` usa en el camino caliente.
    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })
  })

  it('el estado sobrevive: la billetera no es una variable en memoria', async ({ task }) => {
    const oreja = billetera(task)
    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })

    // Se pide el objeto DE NUEVO por su nombre. Si el estado viviera en una
    // propiedad de la clase y no en el SQLite, esto daria cero.
    const otraVez = env.BILLETERA.get(env.BILLETERA.idFromName(task.fullName))
    const saldo = await otraVez.saldo()
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(100_000)
  })
})

describe('las reservas, por el metodo publico del DO', () => {
  const op = (clave: string) => ({
    clave_idem: clave,
    correlacion_id: 'c1',
    momento: '2026-08-17T12:00:00.000Z',
  })

  /** Una billetera con credito de promocion y disponible, para que la precedencia
   *  tenga algo que decidir. */
  async function conSaldo(oreja: ReturnType<typeof billetera>) {
    await oreja.acreditar(op('c1'), {
      monto: guaranies(30_000),
      bolsa: 'credito_promocion',
      concepto: 'premio',
      origen: 'campania',
      vence_en: '2026-12-31T00:00:00.000Z',
    })
    await oreja.acreditar(op('c2'), {
      monto: guaranies(70_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
  }

  const enElFuturo = () => new Date(Date.now() + 30 * 60 * 1000).toISOString()

  it('reservar mueve la plata a retenido, no la debita contra la nada', async ({ task }) => {
    const oreja = billetera(task)
    await conSaldo(oreja)

    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: enElFuturo(),
    })

    const saldo = await oreja.saldo()
    // El total no cambia: la plata sigue adentro de la billetera, en otra bolsa.
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(100_000)
    expect(saldo.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)).toBe(
      50_000,
    )
    // Y salio primero del credito de promocion, que es el que vence (ley 4).
    expect(saldo.bolsas.filter((b) => b.tipo === 'credito_promocion')).toEqual([])

    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })
  })

  it('el consumo parcial mueve `consumido` y saca del retenido', async ({ task }) => {
    // `Reserva.consumido` estuvo declarado desde la Fase 0 sin nada que lo
    // incrementara. Esta es la prueba de que ya existe quien lo mueva.
    const oreja = billetera(task)
    await conSaldo(oreja)
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: enElFuturo(),
    })

    const r = await oreja.consumirReserva(op('u1'), {
      reserva_id: 'promo-1',
      monto: guaranies(20_000),
    })

    expect(r.valor.consumido).toBe(20_000)
    expect(r.valor.disponible).toBe(30_000)

    const saldo = await oreja.saldo()
    // Esa plata se fue de la billetera: 100.000 - 20.000.
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(80_000)
    expect(saldo.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)).toBe(
      30_000,
    )
    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })
  })

  it('no se puede consumir mas de lo que la reserva tiene', async ({ task }) => {
    const oreja = billetera(task)
    await conSaldo(oreja)
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: enElFuturo(),
    })
    await oreja.consumirReserva(op('u1'), { reserva_id: 'promo-1', monto: guaranies(20_000) })

    let error: unknown = null
    try {
      await oreja.consumirReserva(op('u2'), { reserva_id: 'promo-1', monto: guaranies(30_001) })
    } catch (e) {
      error = e
    }
    // Un guarani mas que lo que queda. Sin la cota, el remanente que vuelve al
    // usuario sale negativo — y una bolsa en negativo es plata inventada.
    expect(String(error)).toMatch(/quedan 30000/)

    // Y el rechazo no dejo nada a medias.
    const saldo = await oreja.saldo()
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(80_000)
  })

  it('liberar devuelve el remanente A LA BOLSA DE LA QUE SALIO (ley 11)', async ({ task }) => {
    // La regla anticajero. Se reserva tomando credito de promocion primero, se
    // consume una parte, y lo que vuelve tiene que volver COMO CREDITO, con su
    // vencimiento original — no convertido en plata retirable.
    const oreja = billetera(task)
    await conSaldo(oreja)
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: enElFuturo(),
    })
    await oreja.consumirReserva(op('u1'), { reserva_id: 'promo-1', monto: guaranies(10_000) })

    const r = await oreja.liberarReserva(op('l1'), { reserva_id: 'promo-1' })
    expect(r.valor.devuelto).toBe(40_000)

    const saldo = await oreja.saldo()
    expect(saldo.bolsas.filter((b) => b.tipo === 'retenido')).toEqual([])

    // Lo que se consumio salio del credito (que va primero), asi que lo que vuelve
    // es sobre todo disponible — pero el credito que quede tiene que volver COMO
    // credito y con su vencimiento, nunca como disponible.
    const credito = saldo.bolsas.filter((b) => b.tipo === 'credito_promocion')
    // Sin esta linea, la prueba de la ley 11 pasaba con la ley 11 rota: si el
    // remanente volviera TODO como `disponible` —que es la violacion exacta— el
    // filtro queda vacio, el `for` no afirma nada y el total sigue dando. Lo
    // encontro una auditoria adversarial.
    expect(credito.length).toBeGreaterThan(0)
    for (const b of credito) expect(b.vence_en).toBe('2026-12-31T00:00:00.000Z')

    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(90_000)
    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })
  })

  it('un reserva_id ya cerrado NO se puede reusar, POR EL METODO PUBLICO', async ({ task }) => {
    // Esta prueba la pidio la segunda vuelta de auditoria, y el motivo es exacto:
    // el arreglo de «un reserva_id se usa una vez» vive en el nucleo
    // (`estado.reservas.has(...)`) y solo funciona si el estado TRAE la reserva
    // cerrada. Eso depende de dos lineas que ninguna prueba tocaba —
    // `this.operar(op, entrada.reserva_id, …)` en el DO, y el `OR reserva_id = ?`
    // de `cargarReservas`— y las dos mutaciones sobrevivian a las dos suites
    // enteras.
    //
    // Con la segunda mutacion puesta, la auditoria reprodujo el daño completo por
    // este mismo camino: el reuso entraba, las tomas nuevas se descartaban por el
    // `INSERT OR IGNORE`, y la operacion siguiente moria con «descuadre en
    // retenido: bolsas 20000 vs reservas abiertas 50000» — plata retenida sin
    // camino de salida.
    const oreja = billetera(task)
    await oreja.acreditar(op('c1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(dentroDeMediaHora()).toISOString(),
    })
    await oreja.liberarReserva(op('l1'), { reserva_id: 'promo-1' })

    let error: unknown = null
    try {
      await oreja.reservar(op('r2'), {
        reserva_id: 'promo-1',
        monto: guaranies(20_000),
        vence_en: new Date(dentroDeMediaHora()).toISOString(),
      })
    } catch (e) {
      error = e
    }
    expect(String(error)).toMatch(/ya se uso \(quedo cancelada\)/)

    // Y la billetera sigue sana: el rechazo no dejo nada a medias.
    const saldo = await oreja.saldo()
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(100_000)
    expect(saldo.bolsas.filter((b) => b.tipo === 'retenido')).toEqual([])
    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })

    // Un id distinto SI entra: lo que se rechaza es el reuso, no reservar de nuevo.
    const otra = await oreja.reservar(op('r3'), {
      reserva_id: 'promo-2',
      monto: guaranies(20_000),
      vence_en: new Date(dentroDeMediaHora()).toISOString(),
    })
    expect(otra.repetida).toBe(false)
  })

  it('liberar dos veces distingue "ya se libero" de "no existe"', async ({ task }) => {
    // La otra promesa que colgaba de la misma linea de `cargarReservas`, y que la
    // auditoria midio sin oraculo: su encabezado dice que sin el `OR reserva_id = ?`
    // no se podrian distinguir estos dos casos. Ahora hay quien lo diga.
    const oreja = billetera(task)
    await oreja.acreditar(op('c1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(dentroDeMediaHora()).toISOString(),
    })

    const primera = await oreja.liberarReserva(op('l1'), { reserva_id: 'promo-1' })
    expect(primera.valor.devuelto).toBe(50_000)

    // Ya liberada, con OTRA clave de idempotencia: no es un error, y no devuelve
    // nada. Si la reserva cerrada no se cargara, esto diria «reserva desconocida».
    const segunda = await oreja.liberarReserva(op('l2'), { reserva_id: 'promo-1' })
    expect(segunda.repetida).toBe(true)
    expect(segunda.valor.devuelto).toBe(0)

    // Y una que nunca existio SI es un error.
    let error: unknown = null
    try {
      await oreja.liberarReserva(op('l3'), { reserva_id: 'jamas-existio' })
    } catch (e) {
      error = e
    }
    expect(String(error)).toMatch(/reserva desconocida/)

    const saldo = await oreja.saldo()
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(100_000)
  })

  it('reservar deja la alarma programada para el vencimiento', async ({ task }) => {
    // La primera mitad del mecanismo: que la alarma quede puesta, y puesta EN el
    // instante correcto. Se comprueba leyendo la alarma, sin esperar a que suene:
    // una prueba que espera por reloj es una prueba que falla sola algun martes.
    const oreja = billetera(task)
    await conSaldo(oreja)
    const vence = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: vence,
    })

    // Se drena primero, y esto es de esta entrega: la alarma ya no tiene un solo
    // motivo. Con filas pendientes en el outbox apunta a "ahora" —publicar es lo
    // primero que hay que hacer— y recien cuando la cola queda vacia vuelve a
    // apuntar al vencimiento. Afirmar sin drenar seria afirmar sobre una carrera.
    const d = await drenar(oreja)
    expect(d.outbox.pendientes).toBe(0)
    expect(d.alarma).toBe(Date.parse(vence))
  })

  it('la reserva abandonada se libera sola cuando vence', async ({ task }) => {
    // La segunda mitad: que el handler libere lo vencido y devuelva la plata.
    //
    // Se invoca `alarm()` directo en vez de esperar a que Cloudflare lo llame, y
    // no es una comodidad: una reserva ya vencida hace que `reprogramarAlarma`
    // ponga la alarma para AHORA, y entonces se dispara sola antes de que la
    // prueba alcance a preguntar por ella. `runDurableObjectAlarm` devolvia
    // `false` —no porque el mecanismo fallara, sino porque ya habia corrido—.
    //
    // Que Cloudflare invoque `alarm()` a su hora es trabajo de Cloudflare, y las
    // dos sondas de la plataforma ya lo miden. Lo nuestro es lo que el handler
    // hace cuando corre.
    const oreja = billetera(task)
    await conSaldo(oreja)

    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(Date.now() - 1000).toISOString(),
    })

    const antes = await oreja.saldo()
    expect(antes.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)).toBe(
      50_000,
    )

    await runInDurableObject(oreja, async (instancia) => {
      await instancia.alarm?.()
    })

    const despues = await oreja.saldo()
    // El retenido volvio a sus bolsas de origen. Nada se perdio.
    expect(despues.bolsas.filter((b) => b.tipo === 'retenido')).toEqual([])
    expect(despues.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(100_000)
    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })
  })

  it('sin reservas abiertas no queda ninguna alarma colgada', async ({ task }) => {
    // Una alarma que sobrevive a la reserva que la justificaba despierta el objeto
    // para nada, para siempre.
    const oreja = billetera(task)
    await conSaldo(oreja)
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: enElFuturo(),
    })
    await oreja.liberarReserva(op('l1'), { reserva_id: 'promo-1' })

    // Con el outbox vaciado y sin reservas abiertas no queda NINGUN motivo para
    // despertar al objeto, y entonces la alarma se borra. Que el outbox pendiente
    // la sostenga es correcto; que la sostenga cuando ya no hay nada, no.
    const d = await drenar(oreja)
    expect(d.alarma).toBeNull()
  })

  it('la alarma que se dispara dos veces no libera dos veces', async ({ task }) => {
    // Cloudflare reintenta las alarmas que fallan: entregar doble no es una
    // hipotesis. La clave de idempotencia del vencimiento es derivada y estable,
    // asi que la segunda pasada no hace nada.
    const oreja = billetera(task)
    await conSaldo(oreja)
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(Date.now() - 1000).toISOString(),
    })

    await runDurableObjectAlarm(oreja)
    const primera = await oreja.saldo()

    // Se fuerza una segunda pasada del handler, como haria un reintento.
    await runInDurableObject(oreja, async (instancia) => {
      await instancia.alarm?.()
    })

    const segunda = await oreja.saldo()
    expect(segunda.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(
      primera.bolsas.reduce((a, b) => a + b.monto, 0),
    )
    expect(segunda.asientos).toBe(primera.asientos)
    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })
  })

  it('una reserva que todavia no vencio NO la toca la alarma', async ({ task }) => {
    // Si la alarma liberara todo lo que encuentra, una campaña en curso se
    // cancelaria sola. Es el defecto mas caro que puede tener este mecanismo.
    const oreja = billetera(task)
    await conSaldo(oreja)
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: enElFuturo(),
    })

    await runInDurableObject(oreja, async (instancia) => {
      await instancia.alarm?.()
    })

    const saldo = await oreja.saldo()
    expect(saldo.bolsas.filter((b) => b.tipo === 'retenido').reduce((a, b) => a + b.monto, 0)).toBe(
      50_000,
    )
  })
})

describe('el publicador del outbox, contra la D1 de verdad', () => {
  // La otra mitad de la ley 5. El evento ya se escribia en la misma transaccion
  // que el cambio; lo que faltaba era sacarlo de ahi. Estas pruebas corren contra
  // el esquema que sale de `migraciones/core/`, aplicado por `applyD1Migrations`:
  // no hay tabla de juguete: si 0002 estuviera mal, esto se cae.

  const op = (clave: string) => ({
    clave_idem: clave,
    correlacion_id: 'c1',
    momento: '2026-08-17T12:00:00.000Z',
  })

  /** Lo que quedo en D1 para UNA billetera. El filtro por billetera importa: la D1
   *  local es una sola para todo el archivo, y sin el, una prueba contaria las
   *  filas que dejo otra. */
  async function enD1(id: string) {
    const asientos = await env.CORE.prepare(
      'SELECT asiento_id, concepto, monto, bolsa FROM ledger_copia WHERE billetera_id = ? ORDER BY asiento_id',
    )
      .bind(id)
      .all<{ asiento_id: string; concepto: string; monto: number; bolsa: string }>()

    const eventos = await env.CORE.prepare(
      'SELECT evento_id, tipo FROM eventos_billetera WHERE billetera_id = ? ORDER BY evento_id',
    )
      .bind(id)
      .all<{ evento_id: number; tipo: string }>()

    return { asientos: asientos.results, eventos: eventos.results }
  }

  it('el asiento llega a ledger_copia y el evento a eventos_billetera', async ({ task }) => {
    const oreja = billetera(task)
    const id = env.BILLETERA.idFromName(task.fullName).toString()

    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })

    const d = await drenar(oreja)
    expect(d.outbox.pendientes).toBe(0)

    const copia = await enD1(id)
    // El asiento, con su monto y su bolsa. Esta tabla es la que lee el panel
    // (ley 1): si quedara vacia, los reportes mostrarian una billetera sin
    // movimientos y la plata estaria igual adentro del Durable Object.
    expect(copia.asientos).toEqual([
      { asiento_id: 'k1:cr', concepto: 'carga', monto: 100_000, bolsa: 'disponible' },
    ])
    expect(copia.eventos.map((e) => e.tipo)).toEqual(['billetera.acreditada'])
  })

  it('publicar dos veces lo mismo NO duplica: ley 6, por clave primaria', async ({ task }) => {
    // La ventana es real y no se puede cerrar: el publicador escribe en D1 y
    // DESPUES marca la fila en el Durable Object. Si el objeto se cae en el medio,
    // la proxima pasada manda lo mismo otra vez.
    //
    // Acá se reproduce esa caida exactamente: se borra la marca de publicado y se
    // publica de nuevo. Lo que tiene que absorber el duplicado es la clave primaria
    // de cada destino, no el cuidado del publicador.
    const oreja = billetera(task)
    const id = env.BILLETERA.idFromName(task.fullName).toString()

    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await drenar(oreja)
    const primera = await enD1(id)
    expect(primera.asientos.length).toBe(1)
    expect(primera.eventos.length).toBe(1)

    // La caida: D1 ya recibio todo, el DO nunca se entero.
    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec('UPDATE outbox SET publicado_en = NULL')
    })

    const r = await oreja.publicar()
    // Y ESTO es lo que separa "no duplico" de "no publico": si el INSERT fuera sin
    // `OR IGNORE`, el lote entero fallaria por la clave primaria, el publicador lo
    // atraparia y las filas quedarian pendientes para siempre. Las cuentas de abajo
    // seguirian dando 1 y la prueba mentiria.
    expect(r.publicados).toBe(2)
    expect(r.pendientes).toBe(0)

    const segunda = await enD1(id)
    expect(segunda).toEqual(primera)
  })

  it('el evento se identifica por el id del outbox, no por su contenido', async ({ task }) => {
    // Dos acreditaciones IDENTICAS salvo la clave de idempotencia son dos eventos
    // distintos con cuerpos casi iguales. Si la identidad saliera del contenido, la
    // segunda se perderia en silencio como si fuera un duplicado — plata acreditada
    // que los reportes nunca ven.
    const oreja = billetera(task)
    const id = env.BILLETERA.idFromName(task.fullName).toString()

    for (const clave of ['k1', 'k2']) {
      await oreja.acreditar(op(clave), {
        monto: guaranies(10_000),
        bolsa: 'disponible',
        concepto: 'carga',
        origen: 'dpago',
      })
    }
    await drenar(oreja)

    const copia = await enD1(id)
    expect(copia.eventos.length).toBe(2)
    // Ids distintos y crecientes: el orden de D1 es el orden en que la plata se
    // movio.
    expect(copia.eventos[0]!.evento_id).toBeLessThan(copia.eventos[1]!.evento_id)
    expect(copia.asientos.map((a) => a.asiento_id)).toEqual(['k1:cr', 'k2:cr'])
  })

  it('dos billeteras con la MISMA clave de idempotencia no se pisan en el ledger', async ({
    task,
  }) => {
    // ESTA prueba nacio de un fallo del arnes, no de una idea. La primera corrida
    // del publicador dejo `ledger_copia` vacia en cuatro pruebas, sin un solo
    // error: `asiento_id` es `${clave_idem}:${sufijo}`, y 0001 lo habia declarado
    // PRIMARY KEY a secas en una tabla donde conviven TODAS las billeteras. La
    // primera prueba que escribia `k1:cr` se quedaba con la fila y el `OR IGNORE`
    // descartaba las demas en silencio.
    //
    // Y no es una casualidad del arnes: es EL caso del reparto, que es la Fase 1.
    // Un pago se reparte entre el vendedor, el creador y la plataforma — tres
    // movimientos, el mismo acto, la misma clave `{pedido_id}:{paso}`, tres
    // billeteras. Con la clave vieja el panel mostraba uno de los tres.
    //
    // 0002 reconstruye la tabla con `PRIMARY KEY (billetera_id, asiento_id)`. Esto
    // es lo que lo sostiene.
    const nombreA = `${task.fullName} · A`
    const nombreB = `${task.fullName} · B`
    const a = env.BILLETERA.get(env.BILLETERA.idFromName(nombreA))
    const b = env.BILLETERA.get(env.BILLETERA.idFromName(nombreB))

    const entrada = {
      monto: guaranies(40_000),
      bolsa: 'disponible' as const,
      concepto: 'reparto',
      origen: 'pedido',
    }
    // La MISMA clave para las dos, que es lo correcto: es el mismo acto.
    await a.acreditar(op('pedido-7:reparto'), entrada)
    await b.acreditar(op('pedido-7:reparto'), entrada)

    await drenar(a)
    await drenar(b)

    const enA = await enD1(env.BILLETERA.idFromName(nombreA).toString())
    const enB = await enD1(env.BILLETERA.idFromName(nombreB).toString())

    // Las dos partes del reparto estan. Con la clave vieja, una de las dos
    // desaparecia y la unica pista era una tabla mas corta de lo que deberia.
    expect(enA.asientos.map((x) => x.asiento_id)).toEqual(['pedido-7:reparto:cr'])
    expect(enB.asientos.map((x) => x.asiento_id)).toEqual(['pedido-7:reparto:cr'])
    expect(enA.asientos[0]?.monto).toBe(40_000)
    expect(enB.asientos[0]?.monto).toBe(40_000)
  })

  it('una operacion que falla no publica nada, porque no escribio nada', async ({ task }) => {
    const oreja = billetera(task)
    const id = env.BILLETERA.idFromName(task.fullName).toString()

    let error: unknown = null
    try {
      await oreja.debitar(op('k1'), { monto: guaranies(1), concepto: 'compra' })
    } catch (e) {
      error = e
    }
    expect(String(error)).toMatch(/saldo insuficiente/)

    const d = await oreja.publicar()
    expect(d).toEqual({ publicados: 0, pendientes: 0 })
    expect(await enD1(id)).toEqual({ asientos: [], eventos: [] })
  })

  it('la reserva completa deja su rastro entero en D1', async ({ task }) => {
    // El camino largo: reservar, consumir a medias, liberar. Cada paso asienta y
    // avisa, y lo que llega a D1 tiene que permitir reconstruir la historia.
    const oreja = billetera(task)
    const id = env.BILLETERA.idFromName(task.fullName).toString()

    await oreja.acreditar(op('c1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(dentroDeMediaHora()).toISOString(),
    })
    await oreja.consumirReserva(op('u1'), { reserva_id: 'promo-1', monto: guaranies(20_000) })
    await oreja.liberarReserva(op('l1'), { reserva_id: 'promo-1' })

    await drenar(oreja)
    const copia = await enD1(id)

    expect(copia.eventos.map((e) => e.tipo)).toEqual([
      'billetera.acreditada',
      'billetera.reservada',
      'billetera.reserva_consumida',
      'billetera.reserva_liberada',
    ])

    // Y el ledger de D1 suma lo mismo que el saldo que quedo en la billetera. Si
    // los dos numeros se separan, el panel miente sobre plata de verdad.
    const saldo = await oreja.saldo()
    expect(copia.asientos.reduce((a, x) => a + x.monto, 0)).toBe(
      saldo.bolsas.reduce((a, b) => a + b.monto, 0),
    )
    expect(copia.asientos.length).toBe(saldo.asientos)
  })

  it('la reserva que vence sola tambien publica lo que hizo', async ({ task }) => {
    // El vencimiento devuelve plata sin que nadie lo pida. Es justamente el caso en
    // el que nadie va a estar mirando: si el evento no saliera, el unico rastro de
    // esa devolucion viviria adentro del Durable Object.
    const oreja = billetera(task)
    const id = env.BILLETERA.idFromName(task.fullName).toString()

    await oreja.acreditar(op('c1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(Date.now() - 1000).toISOString(),
    })

    const d = await drenar(oreja)
    expect(d.outbox.pendientes).toBe(0)

    const copia = await enD1(id)
    expect(copia.eventos.map((e) => e.tipo)).toContain('billetera.reserva_liberada')
  })

  it('el diagnostico muestra un outbox atascado', async ({ task }) => {
    // Un outbox que no avanza es plata movida que los reportes nunca ven, y no
    // produce ningun error: el publicador atrapa el fallo, cuenta el intento y se
    // reprograma cada vez mas lejos. Lo unico que lo delata es esto.
    const oreja = billetera(task)

    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })

    // Se drena primero para que el objeto quede SIN alarma. Eso es lo que hace
    // determinista lo que sigue: sin alarma no hay quien publique por atras, asi
    // que el atasco que se fabrica abajo se queda quieto hasta que la prueba mire.
    expect((await drenar(oreja)).alarma).toBeNull()

    // El atasco: las dos filas vuelven a pendiente con cuatro intentos encima,
    // como las dejaria una D1 que no contesta hace un rato.
    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec('UPDATE outbox SET publicado_en = NULL, intentos = 4')
    })

    const atascado = await oreja.diagnostico()
    expect(atascado.outbox).toEqual({
      pendientes: 2,
      intentos_maximos: 4,
      mas_viejo: '2026-08-17T12:00:00.000Z',
    })

    // Y cuando D1 vuelve, se destraba solo y el diagnostico queda limpio.
    expect(await oreja.publicar()).toEqual({ publicados: 2, pendientes: 0 })
    const d = await oreja.diagnostico()
    expect(d.outbox).toEqual({ pendientes: 0, intentos_maximos: 0, mas_viejo: null })
  })

  it('el outbox pendiente programa la alarma, y con la espera que le toca', async ({ task }) => {
    // Esto es lo que hace que el publicador arranque solo. Sin esta linea, los
    // eventos se quedan en el outbox hasta que alguien vuelva a tocar la billetera
    // —podrian ser meses— y no falla nada: `saldo()` y `reconciliar()` dan bien,
    // porque la plata esta. Lo unico que esta mal es que nadie afuera lo sabe.
    //
    // Se prueba con DOCE intentos encima a proposito. Con cero, la alarma se
    // programa para AHORA y se dispara sola antes de que la prueba pueda leerla:
    // la afirmacion seria una carrera. Con doce el retraso esta en el techo —cinco
    // minutos, porque `2**11 * 1000` pasa de largo `RETRASO_MAXIMO_MS`— y la alarma
    // se queda quieta, medible.
    //
    // Decia NUEVE, y una auditoria lo corrigio contando: `retrasoPorIntentos(9)` es
    // `2**8 * 1000` = 256 s = 4 min 16 s, o sea que el `Math.min` no entraba en
    // juego y el comentario afirmaba una cobertura que no existia. El techo recien
    // se alcanza a los diez.
    const oreja = billetera(task)

    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    expect((await drenar(oreja)).alarma).toBeNull()

    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec('UPDATE outbox SET publicado_en = NULL, intentos = 12')
    })

    // Una operacion REPETIDA: misma clave de idempotencia, asi que no escribe nada
    // nuevo. Lo unico que puede haber programado la alarma es el outbox pendiente.
    const antes = Date.now()
    const r = await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    expect(r.repetida).toBe(true)

    const d = await oreja.diagnostico()
    expect(d.outbox.pendientes).toBe(2)
    expect(d.alarma).not.toBeNull()
    // Exactamente el techo: la alarma es `ahora + 300_000`, y `ahora` cayo entre
    // `antes` y este instante. Sin el backoff seria "ahora" a secas, y el objeto
    // despertaria en bucle contra una D1 que no contesta.
    expect(d.alarma!).toBeGreaterThanOrEqual(antes + 5 * 60 * 1000)
    expect(d.alarma!).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000)
  })

  it('lo que no se puede publicar se cuenta, y traba la cola', async ({ task }) => {
    // El caso de la fila envenenada, y esta prueba existe tanto para probar el
    // contador como para dejar escrito el limite: no hay cola de descarte. Una fila
    // que no puede salir NUNCA se queda en la cabeza y bloquea a las que vienen
    // atras. Se ve en `intentos`, no se resuelve solo, y es trabajo de otra entrega.
    const oreja = billetera(task)

    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    expect((await drenar(oreja)).alarma).toBeNull()

    // Una fila que dice ser un asiento y cuyo cuerpo no lo es. Es lo que dejaria un
    // cambio de formato hecho a medias.
    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec(
        'INSERT INTO outbox (tipo, cuerpo, correlacion_id, creado_en) VALUES (?, ?, ?, ?)',
        TIPO_ASIENTO,
        'esto no es un asiento',
        'c9',
        '2026-08-17T13:00:00.000Z',
      )
    })

    expect(await oreja.publicar()).toEqual({ publicados: 0, pendientes: 1 })
    expect((await oreja.diagnostico()).outbox.intentos_maximos).toBe(1)

    // Y el segundo intento suma, que es lo que hace que la espera crezca.
    expect(await oreja.publicar()).toEqual({ publicados: 0, pendientes: 1 })
    expect((await oreja.diagnostico()).outbox.intentos_maximos).toBe(2)
  })

  it('entre los dos motivos de la alarma gana el mas cercano', async ({ task }) => {
    // Hay UNA sola alarma por Durable Object y desde esta entrega tiene dos motivos:
    // una reserva que vence y una fila del outbox que no llego a D1. Que gane el mas
    // lejano significa que el otro llega tarde — y si el que llega tarde es el
    // vencimiento, es plata retenida de mas.
    //
    // Lo dijo el arnes de mutacion, no una auditoria: cambiar `Math.min` por
    // `Math.max` SOBREVIVIO. Todas las pruebas de la alarma tenian un motivo solo, y
    // con un motivo el minimo y el maximo son el mismo numero.
    //
    // Los doce intentos vuelven a ser lo que hace esto medible: con el retraso en
    // el techo —cinco minutos— la alarma se queda quieta el tiempo suficiente para
    // preguntarle. (Doce y no nueve: nueve son 256 s, no el techo.)
    const oreja = billetera(task)
    await oreja.acreditar(op('c1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    await drenar(oreja)

    const atascar = () =>
      runInDurableObject(oreja, (_do, ctx) => {
        ctx.storage.sql.exec('UPDATE outbox SET publicado_en = NULL, intentos = 12')
      })

    // Una operacion repetida no escribe nada: lo unico que hace es reprogramar.
    const reprogramar = () =>
      oreja.acreditar(op('c1'), {
        monto: guaranies(100_000),
        bolsa: 'disponible',
        concepto: 'carga',
        origen: 'dpago',
      })

    // A · el outbox (cinco minutos) contra un vencimiento a media hora: gana el
    //     outbox, que es el mas cercano.
    await atascar()
    let antes = Date.now()
    await reprogramar()
    let alarma = (await oreja.diagnostico()).alarma
    expect(alarma).not.toBeNull()
    expect(alarma!).toBeGreaterThanOrEqual(antes + 5 * 60 * 1000)
    expect(alarma!).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000)

    // B · y al reves. La reserva pasa a vencer en un minuto, el outbox sigue
    //     esperando cinco: ahora el mas cercano es el vencimiento.
    const vence = new Date(Date.now() + 60 * 1000).toISOString()
    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec('UPDATE reservas SET vence_en = ?', vence)
    })
    await atascar()
    antes = Date.now()
    await reprogramar()
    alarma = (await oreja.diagnostico()).alarma
    expect(alarma).toBe(Date.parse(vence))
    expect(alarma!).toBeLessThan(antes + 2 * 60 * 1000)
  })

  it('sin ningun motivo, la alarma se BORRA y no queda colgada', async ({ task }) => {
    // Una alarma que sobrevive al motivo que la justificaba despierta el objeto para
    // nada, para siempre.
    //
    // Esta prueba existe porque la mutacion que le saca el `deleteAlarm()`
    // SOBREVIVIO, y el motivo vale escribirlo: la otra prueba de esto afirmaba
    // `getAlarm() === null` DESPUES de que la alarma ya se habia disparado sola.
    // Null era la respuesta correcta por la razon equivocada — workerd borra la
    // alarma al dispararla, asi que pasaba aunque nuestro codigo no borrara nada.
    //
    // Acá la alarma se pone A MANO para dentro de una hora, o sea que no se va a
    // disparar por su cuenta. Si `reprogramarAlarma` no la borra, sigue ahi.
    const oreja = billetera(task)
    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await drenar(oreja)

    const enUnaHora = Date.now() + 60 * 60 * 1000
    await runInDurableObject(oreja, async (_do, ctx) => {
      await ctx.storage.setAlarm(enUnaHora)
      expect(await ctx.storage.getAlarm()).toBe(enUnaHora)
    })

    // Sin reservas abiertas y con el outbox vacio no queda ningun motivo. La
    // operacion es repetida: no escribe nada, solo reprograma.
    const r = await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    expect(r.repetida).toBe(true)

    expect((await oreja.diagnostico()).alarma).toBeNull()
  })

  it('dos publicaciones a la vez no se pisan', async ({ task }) => {
    // Hace falta porque el `await` a D1 ABRE la compuerta de entrada del Durable
    // Object. La documentacion de Cloudflare lo dice sin vueltas: «Input gates only
    // protect during storage operations. Non-storage I/O like fetch() … allows
    // other requests to interleave.» O sea que la alarma puede dispararse mientras
    // un `publicar()` por RPC espera a D1, y las dos pasadas leerian EL MISMO lote.
    //
    // El comentario que estaba en `publicar()` afirmaba exactamente lo contrario
    // —que el `await` mantiene la compuerta cerrada— y lo volteo una auditoria.
    //
    // Que D1 lo absorba no alcanza: el contador de intentos se sumaria dos veces
    // por un solo fallo y la espera entre reintentos saldria del doble.
    const oreja = billetera(task)
    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    expect((await drenar(oreja)).alarma).toBeNull()

    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec('UPDATE outbox SET publicado_en = NULL')
    })

    // Las dos arrancan ADENTRO del objeto y sin esperar a la otra.
    //
    // Tiene que ser adentro, y esto se midio: con dos llamadas por RPC
    // (`Promise.all([oreja.publicar(), oreja.publicar()])`) la mutacion que le saca
    // el guarda SOBREVIVIA a cinco corridas seguidas — el canal de RPC las serializa,
    // asi que la segunda arrancaba con la primera ya terminada y no habia nada que
    // pisar. Una prueba de concurrencia donde no hay concurrencia prueba el arnes.
    //
    // Llamando al metodo de la instancia, las dos empiezan antes de que ninguna
    // llegue a su `await` a D1, que es donde la compuerta de entrada se abre.
    //
    // La suma es la asercion: hay dos filas pendientes, asi que entre las dos
    // llamadas tienen que publicarse DOS veces. Sin el guarda, las dos leen EL MISMO
    // lote y da cuatro.
    //
    // El cast es local y documentado: `runInDurableObject` tipa la instancia como
    // `DurableObject` a secas —el generico no sale del stub— y `publicar()` es un
    // metodo de `BilleteraDO`. Se declara lo que se espera de el y nada mas.
    const [a, b] = await runInDurableObject(oreja, async (instancia) => {
      const publicar = (instancia as unknown as BilleteraDO).publicar.bind(instancia)
      const uno = publicar()
      const dos = publicar()
      return Promise.all([uno, dos])
    })
    expect(a.publicados + b.publicados).toBe(2)

    // El `pendientes` de la que rebota es una foto del momento en que rebota, y en
    // ese momento la otra todavia no marco nada: puede dar 2 y esta bien. Lo que
    // tiene que quedar en cero es el estado final, y eso se pregunta despues.
    expect((await oreja.diagnostico()).outbox.pendientes).toBe(0)
  })

  it('una reserva que no se puede liberar NO tapa el outbox', async ({ task }) => {
    // El modo de falla que `publicar()` documenta y evita a proposito, entrando por
    // la puerta de al lado: si `alarm()` tira, Cloudflare la reintenta unas cuantas
    // veces y despues deja de hacerlo — el outbox queda pendiente y sin nadie que
    // lo despierte. La mitad de arriba de `alarm()` no tenia esa proteccion.
    const oreja = billetera(task)
    await oreja.acreditar(op('c1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await oreja.reservar(op('r1'), {
      reserva_id: 'promo-1',
      monto: guaranies(50_000),
      vence_en: new Date(dentroDeMediaHora()).toISOString(),
    })
    expect((await drenar(oreja)).outbox.pendientes).toBe(0)

    await runInDurableObject(oreja, (_do, ctx) => {
      // La reserva pasa a estar vencida, sin escribir un solo evento.
      ctx.storage.sql.exec('UPDATE reservas SET vence_en = ?', '2020-01-01T00:00:00.000Z')
      // Y el acumulado del ledger queda corrupto, asi que la liberacion va a fallar
      // por el invariante 2 ANTES de escribir nada.
      ctx.storage.sql.exec("UPDATE totales_ledger SET total = total + 1 WHERE bolsa = 'disponible'")
      // Con algo pendiente para publicar.
      ctx.storage.sql.exec('UPDATE outbox SET publicado_en = NULL')
    })

    // La alarma NO tira, aunque la liberacion adentro haya fallado.
    let error: unknown = null
    try {
      await runInDurableObject(oreja, async (instancia) => {
        await instancia.alarm?.()
      })
    } catch (e) {
      error = e
    }
    expect(error).toBeNull()

    // Y el outbox salio igual, que es todo el punto.
    expect((await oreja.diagnostico()).outbox.pendientes).toBe(0)

    // La reserva sigue abierta y descuadrada: no se arreglo sola, y eso esta bien.
    // Lo que se evito es que UNA reserva rota se lleve puesto al publicador.
    const abiertas = await runInDurableObject(oreja, (_do, ctx) => [
      ...ctx.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM reservas WHERE estado = 'abierta'",
      ),
    ])
    expect(abiertas).toEqual([{ n: 1 }])

    // Y NO queda girando. Esta es la segunda mitad, y la pidio la segunda vuelta de
    // auditoria despues de medir que el try/catch de arriba, solo, producia ~185
    // disparos por segundo sostenidos: el `catch` seguia de largo, la reserva
    // seguia vencida y abierta, y la alarma se reprogramaba para AHORA.
    //
    // Con el fracaso contado, la proxima alarma se aleja. Se afirma sobre el
    // numero programado y no esperando: una prueba que espera por reloj falla sola
    // algun martes.
    const d = await oreja.diagnostico()
    expect(d.liberaciones_fallidas).toEqual([{ reserva_id: 'promo-1', intentos: 1 }])
    expect(d.alarma).not.toBeNull()
    // Un fracaso → un segundo. Sin backoff seria "ahora", o sea <= el instante en
    // que la prueba pregunta.
    expect(d.alarma!).toBeGreaterThan(Date.now())

    // Y el segundo fracaso se aleja MAS que el primero, que es lo que impide el
    // bucle cuando la reserva no se puede arreglar nunca.
    await runInDurableObject(oreja, async (instancia) => {
      await instancia.alarm?.()
    })
    const segunda = await oreja.diagnostico()
    expect(segunda.liberaciones_fallidas).toEqual([{ reserva_id: 'promo-1', intentos: 2 }])
    expect(segunda.alarma!).toBeGreaterThan(d.alarma!)

    // Y cuando el descuadre se arregla, el contador se LIMPIA. Sin esto, una
    // reserva que fallo una vez arrastraria su espera para siempre y los
    // vencimientos siguientes de esta billetera llegarian tarde.
    await runInDurableObject(oreja, (_do, ctx) => {
      ctx.storage.sql.exec("UPDATE totales_ledger SET total = total - 1 WHERE bolsa = 'disponible'")
    })
    await runInDurableObject(oreja, async (instancia) => {
      await instancia.alarm?.()
    })

    const sana = await oreja.diagnostico()
    expect(sana.liberaciones_fallidas).toEqual([])
    expect(await oreja.reconciliar()).toEqual({ ok: true, diferencias: [] })
    // Y la plata volvio, que es de lo que se trataba todo esto.
    const saldo = await oreja.saldo()
    expect(saldo.bolsas.filter((b) => b.tipo === 'retenido')).toEqual([])
    expect(saldo.bolsas.reduce((a, b) => a + b.monto, 0)).toBe(100_000)
  })

  it('D1 no deja editar ni borrar lo que ya se copio', async ({ task }) => {
    // Los triggers de 0001 y 0002. Un registro de lo que paso que se puede editar
    // despues no es un registro de lo que paso — y esta copia es la que lee el
    // panel, o sea la version de los hechos que ve una persona.
    const oreja = billetera(task)
    const id = env.BILLETERA.idFromName(task.fullName).toString()

    await oreja.acreditar(op('k1'), {
      monto: guaranies(100_000),
      bolsa: 'disponible',
      concepto: 'carga',
      origen: 'dpago',
    })
    await drenar(oreja)

    await expect(
      env.CORE.prepare('UPDATE ledger_copia SET monto = 1 WHERE billetera_id = ?').bind(id).run(),
    ).rejects.toThrow(/no se edita/)

    await expect(
      env.CORE.prepare('DELETE FROM eventos_billetera WHERE billetera_id = ?').bind(id).run(),
    ).rejects.toThrow(/no se borra/)

    // Y el rechazo no dejo nada tocado.
    const copia = await enD1(id)
    expect(copia.asientos[0]?.monto).toBe(100_000)
    expect(copia.eventos.length).toBe(1)
  })
})

describe('el Worker desplegado', () => {
  it('/salud contesta y valida el guarani dentro del runtime', async () => {
    // Las pruebas de `tests/` verifican `guaranies()` en Node. Esta lo verifica
    // ADENTRO de workerd, atravesando el fetch, los vars del entorno y el binding
    // — que es el camino que recorre una peticion de verdad.
    const r = await SELF.fetch('https://recargaya-staging.local/salud')

    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      estado: 'vivo',
      entorno: 'staging',
      zona_horaria: 'America/Asuncion',
      moneda: { codigo: 'PYG', decimales: 0, ejemplo: 100000 },
    })
  })

  it('una ruta que no existe da 404, no un 500', async () => {
    const r = await SELF.fetch('https://recargaya-staging.local/no-existe')
    expect(r.status).toBe(404)
  })
})
