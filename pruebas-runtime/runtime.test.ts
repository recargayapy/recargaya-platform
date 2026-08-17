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
 * De las diecinueve pruebas de este archivo:
 *
 *   · DOCE estan ancladas a codigo de `src/` y tienen una mutacion que las mata:
 *     las siete del esquema (ejecutan la cadena que exporta
 *     `src/billetera/esquema.ts`, no una tabla de juguete), las tres de la
 *     transaccion (llaman a `enUnaTransaccion` de `src/billetera/transaccion.ts`),
 *     y las dos de `el Worker desplegado`.
 *   · CUATRO —las dos de aislamiento y las dos homonimas— prueban una convencion
 *     de este archivo y no una linea de produccion. Tres de las cuatro mueren por
 *     su propia asercion con una mutacion del arnes; la cuarta (`el estado
 *     sobrevive dentro de una misma prueba`) es el estado que las otras necesitan.
 *   · Las TRES restantes son SONDAS DE LA PLATAFORMA: las dos de la alarma y la de
 *     `transactionSync`. Verifican que Cloudflare se comporta como suponemos, y no
 *     pueden verificar que nuestro codigo lo use, porque todavia no hay codigo
 *     nuestro que use la alarma. Eso lo cierra el vencimiento de reservas.
 *
 * LA LEY 5 YA TIENE ORACULO, y hasta esta entrega no lo tenia. La version anterior
 * de este encabezado decia, medido por una auditoria:
 *
 *   «Si `BilleteraDO` escribiera el asiento y el evento del outbox en dos `exec`
 *   sueltos, sin transaccion, las catorce pruebas de este archivo pasarian igual.»
 *
 * Era cierto: las pruebas llamaban a `ctx.storage.transaction()` directo, o sea
 * comprobaban que Cloudflare implementa transacciones. Ahora llaman al helper de
 * `src/`, y la mutacion «el asiento y el evento del outbox van en la MISMA
 * transaccion» le saca la transaccion al helper y muere.
 *
 * Lo que TODAVIA falta para cerrar la ley 5 de punta a punta, y no es opcional:
 * una prueba que llame al METODO PUBLICO del `BilleteraDO` con una caida inyectada
 * entre la escritura del asiento y la del outbox — el patron que ya existe en
 * `tests/arnes.ts`. Hoy se comprueba que el helper deshace; falta comprobar que el
 * metodo del DO pasa por el helper. Eso llega cuando el DO se reescriba sobre este
 * esquema, que es el resto de esta misma entrega.
 */
import { env, SELF, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import type { Entorno } from '../src/index.js'
import { ESQUEMA } from '../src/billetera/esquema.js'
import { enUnaTransaccion } from '../src/billetera/transaccion.js'

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
 * Un instante futuro para programar una alarma.
 *
 * Esto NO puede ser una fecha absoluta cableada, y la leccion salio caro: la
 * version anterior usaba `Date.parse('2026-08-17T15:00:00Z')`. Paso a las 13:53
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

  it('un asiento no se edita ni se borra: ley 2, hecha cumplir', async ({ task }) => {
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
      crearEsquema(ctx)
      ctx.storage.sql.exec(
        `INSERT INTO asientos (asiento_id, concepto, monto, bolsa, clave_idem, correlacion_id, asentado_en)
         VALUES ('a1', 'compra', -50000, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00Z')`,
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
             VALUES ('a1', 'compra', -1, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00Z')`,
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
         VALUES ('r1', 0, '2026-08-17T00:30:00Z', 'abierta')`,
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
             VALUES ('a1', 'compra', -1, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00Z')`,
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
           VALUES ('a1', 'compra', -1, 'disponible', 'k1', 'c1', '2026-08-17T00:00:00Z')`,
        )
        ctx.storage.sql.exec(
          `INSERT INTO outbox (tipo, cuerpo, correlacion_id, creado_en)
           VALUES ('billetera.debitada', '{}', 'c1', '2026-08-17T00:00:00Z')`,
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
    // una VENTAJA: impide que una transaccion abarque I/O externo y quede abierta
    // con el input gate cerrado), no porque el arnes le haya cerrado la puerta.
    const quedaron = await runInDurableObject(billetera(task), (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE asientos (id TEXT PRIMARY KEY) STRICT')

      try {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec("INSERT INTO asientos (id) VALUES ('a1')")
          throw new Error('caida inyectada')
        })
      } catch {
        /* a proposito */
      }

      return [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')]
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

describe('el Worker desplegado', () => {
  it('/salud contesta y valida el guarani dentro del runtime', async () => {
    // Las 50 pruebas de `tests/` verifican `guaranies()` en Node. Esta lo
    // verifica ADENTRO de workerd, atravesando el fetch, los vars del entorno y
    // el binding — que es el camino que recorre una peticion de verdad. Es una
    // de las dos pruebas de este archivo ancladas a codigo de `src/`.
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
