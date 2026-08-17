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
 * De las doce pruebas de este archivo, DOS estan ancladas a codigo de `src/`
 * (las dos de `/salud`) y tienen mutacion que las mata. Las otras diez son
 * SONDAS DE LA PLATAFORMA: crean sus propias tablas y le hablan a la API de
 * Cloudflare. Verifican que los mecanismos se comportan como la entrega
 * siguiente va a suponer, y no pueden verificar que nuestro codigo los use,
 * porque todavia no hay codigo nuestro que los use.
 *
 * Lo dice una auditoria de esta entrega, y queda escrito para que nadie lea
 * "41/41 mutaciones muertas" como si las doce estuvieran cubiertas:
 *
 *   Si `BilleteraDO` escribiera el asiento y el evento del outbox en dos `exec`
 *   sueltos, sin transaccion, las doce pruebas de este archivo pasarian igual.
 *   La ley 5 NO tiene oraculo todavia.
 *
 * Lo que la entrega siguiente tiene que hacer para cerrarlo, y no es opcional:
 *
 *   1. El DDL del DO vive en `src/`, exportado como constante, y estas pruebas
 *      ejecutan ESA cadena en vez de una tabla de juguete. Recien ahi se pueden
 *      agregar las mutaciones que le saquen `STRICT` y el `CHECK`.
 *   2. La transaccion vive en un helper de `src/`, y la prueba de rollback llama
 *      al helper. La mutacion que le saca la transaccion tiene que morir.
 *   3. Una prueba que llame al metodo publico del DO con una caida inyectada
 *      entre las dos escrituras — el patron que ya existe en `tests/arnes.ts`.
 */
import { env, SELF, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import type { Entorno } from '../src/index.js'

/**
 * El `env` de las pruebas se tipa con `Cloudflare.Env`, que lo GENERA wrangler
 * desde `wrangler.jsonc` (`worker-configuration.d.ts`, 921 bytes, regenerado y
 * comparado por `check-entorno.mjs` en cada `npm run verificar`).
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
 * Una billetera por prueba, con el nombre DERIVADO del nombre de la prueba.
 *
 * No es cosmetica. Medido por la auditoria: en esta version del pool no hay
 * `isolatedStorage` y el storage NO se resetea entre pruebas del mismo archivo —
 * dos `it` con el mismo nombre de DO comparten tablas y filas. Hoy eso se nota
 * porque las pruebas hacen `CREATE TABLE` y la segunda choca; en cuanto el
 * esquema lo cree el constructor del DO, ese aviso desaparece y una prueba de
 * saldo pasaria por plata que dejo otra.
 *
 * Con el nombre derivado, dos pruebas no pueden pisarse por descuido. Y hay una
 * mutacion que lo rompe a proposito, para que la convencion no sea una promesa.
 */
function billetera(nombreDeLaPrueba: string) {
  return env.BILLETERA.get(env.BILLETERA.idFromName(nombreDeLaPrueba))
}

describe('el SQLite del Durable Object', () => {
  it('existe y guarda lo que se le escribe', async ({ task }) => {
    const filas = await runInDurableObject(billetera(task.name), (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE t (clave TEXT PRIMARY KEY, monto INTEGER NOT NULL) STRICT')
      ctx.storage.sql.exec("INSERT INTO t (clave, monto) VALUES ('a', 100000)")
      return [...ctx.storage.sql.exec<{ clave: string; monto: number }>('SELECT clave, monto FROM t')]
    })

    expect(filas).toEqual([{ clave: 'a', monto: 100000 }])
  })

  it('aplica STRICT: un entero no acepta texto', async ({ task }) => {
    // Importa para la entrega siguiente: los guaranies van a vivir en columnas
    // INTEGER, y STRICT es lo que impide que un '100000' de texto entre y ordene
    // como texto.
    //
    // El `CREATE TABLE` va AFUERA del try a proposito: si un DDL roto cayera
    // adentro, su error haria pasar la prueba. Y se afirma sobre el MENSAJE, no
    // sobre "hubo error": la version anterior usaba `expect(error).not.toBeNull()`
    // y la auditoria la hizo pasar con un INSERT a una columna inexistente, o
    // sea afirmando "algo tiro error" en vez de "STRICT manda".
    const r = await runInDurableObject(billetera(task.name), (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE m (monto INTEGER NOT NULL) STRICT')

      let error: string | null = null
      try {
        ctx.storage.sql.exec("INSERT INTO m (monto) VALUES ('cien mil')")
      } catch (e) {
        error = (e as Error).message
      }

      // Control positivo: el INSERT valido SI entra. Sin esto no se distingue
      // "la restriccion manda" de "el INSERT no funciona".
      ctx.storage.sql.exec('INSERT INTO m (monto) VALUES (100000)')

      return {
        error,
        filas: [...ctx.storage.sql.exec<{ monto: number }>('SELECT monto FROM m')],
      }
    })

    expect(r.error).toMatch(/INTEGER/i)
    expect(r.filas).toEqual([{ monto: 100000 }])
  })

  it('aplica CHECK: una bolsa inventada no entra', async ({ task }) => {
    // `ledger_copia` en D1 ya usa un CHECK para los tipos de bolsa, y
    // `check-esquema.mjs` existe para que TypeScript y ese CHECK no se
    // desincronicen. La entrega siguiente pone el MISMO CHECK adentro del DO,
    // que es donde nace el asiento. Esta sonda confirma que ahi tambien manda.
    const r = await runInDurableObject(billetera(task.name), (_do, ctx) => {
      ctx.storage.sql.exec(
        "CREATE TABLE b (tipo TEXT NOT NULL CHECK (tipo IN ('disponible', 'retenido'))) STRICT",
      )

      let error: string | null = null
      try {
        ctx.storage.sql.exec("INSERT INTO b (tipo) VALUES ('inventada')")
      } catch (e) {
        error = (e as Error).message
      }

      ctx.storage.sql.exec("INSERT INTO b (tipo) VALUES ('retenido')")

      return {
        error,
        filas: [...ctx.storage.sql.exec<{ tipo: string }>('SELECT tipo FROM b')],
      }
    })

    expect(r.error).toMatch(/CHECK/i)
    expect(r.filas).toEqual([{ tipo: 'retenido' }])
  })
})

describe('la transaccion de storage', () => {
  it('deshace TODA la escritura cuando algo falla en el medio', async ({ task }) => {
    // La ley 5 pide que el evento del outbox y el asiento se escriban en la
    // misma transaccion. Esta sonda mide que el mecanismo cumple: una caida en
    // el medio no deja ni uno de los dos. Lo que NO mide —y esta escrito arriba—
    // es que nuestro codigo lo use.
    const quedaron = await runInDurableObject(billetera(task.name), async (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE asientos (id TEXT PRIMARY KEY) STRICT')
      ctx.storage.sql.exec('CREATE TABLE outbox (id TEXT PRIMARY KEY) STRICT')

      try {
        await ctx.storage.transaction(async () => {
          ctx.storage.sql.exec("INSERT INTO asientos (id) VALUES ('a1')")
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
    const quedaron = await runInDurableObject(billetera(task.name), async (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE asientos (id TEXT PRIMARY KEY) STRICT')
      ctx.storage.sql.exec('CREATE TABLE outbox (id TEXT PRIMARY KEY) STRICT')

      await ctx.storage.transaction(async () => {
        ctx.storage.sql.exec("INSERT INTO asientos (id) VALUES ('a1')")
        ctx.storage.sql.exec("INSERT INTO outbox (id) VALUES ('e1')")
      })

      return {
        asientos: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM asientos')],
        outbox: [...ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')],
      }
    })

    expect(quedaron.asientos).toEqual([{ n: 1 }])
    expect(quedaron.outbox).toEqual([{ n: 1 }])
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
    const quedaron = await runInDurableObject(billetera(task.name), (_do, ctx) => {
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
    const vencimiento = Date.parse('2026-08-17T15:00:00Z')

    await runInDurableObject(billetera(task.name), async (_do, ctx) => {
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
    const oreja = billetera(task.name)

    // Sin alarma programada: no hay nada que disparar.
    expect(await runDurableObjectAlarm(oreja)).toBe(false)

    await runInDurableObject(oreja, async (_do, ctx) => {
      await ctx.storage.setAlarm(Date.parse('2026-08-17T15:00:00Z'))
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
  // Estas dos existen porque la auditoria midio que el storage NO se resetea
  // entre pruebas del mismo archivo, y que en esta version del pool no hay
  // ninguna opcion que lo haga. El aislamiento es una convencion —el nombre del
  // DO— y una convencion sin oraculo se rompe sola. Estas dos son el oraculo.

  it('el estado sobrevive dentro de una misma prueba', async ({ task }) => {
    const oreja = billetera(task.name)

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
    // visible aca y esto fallaria. Esta es la prueba que la mutacion del
    // aislamiento mata.
    const tablas = await runInDurableObject(billetera(task.name), (_do, ctx) => [
      ...ctx.storage.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'marca'",
      ),
    ])

    expect(tablas).toEqual([{ n: 0 }])
  })
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
