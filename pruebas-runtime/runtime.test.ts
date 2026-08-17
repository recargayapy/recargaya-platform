/**
 * Lo que el Durable Object real puede hacer, comprobado sobre workerd.
 *
 * Por que esto existe como entrega propia, antes de escribir una linea del
 * Wallet DO: la entrega siguiente apoya la plata sobre tres mecanismos de
 * Cloudflare que hoy el proyecto nunca ejecuto — el SQLite del DO, la alarma que
 * vence una reserva sola, y el rollback de la transaccion de storage que hace
 * cumplir la ley 5 (el evento se escribe en la MISMA transaccion que el cambio).
 *
 * Sin estas pruebas, la unica forma de probar el DO seria fabricando un doble de
 * la storage de Cloudflare. Y el metodo del proyecto es explicito: un doble mas
 * debil, mas fuerte o mas permisivo que el original prueba el doble, no el
 * codigo. La plata no se prueba contra una imitacion.
 *
 * Estas cuatro pruebas no verifican logica de negocio — todavia no hay ninguna
 * aca. Verifican que el arnes es real y que los mecanismos se comportan como la
 * entrega siguiente va a suponer que se comportan. Si alguna dejara de pasar, la
 * suposicion cambio y hay que enterarse antes de apoyar plata encima.
 */
import { env, SELF, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import type { Entorno } from '../src/index.js'

/**
 * El `env` de las pruebas se tipa con el MISMO `Entorno` que declara el Worker,
 * no con una copia escrita a mano para las pruebas. Una copia seria un doble de
 * la configuracion: agregar un binding en `src/index.ts` y olvidarlo aca daria
 * pruebas que compilan contra un entorno que no existe.
 *
 * Lo que esto NO cierra, y queda anotado: que `Entorno` coincida con lo que
 * declara `wrangler.jsonc`. Eso lo resuelve `wrangler types`, que genera la
 * interfaz desde la configuracion — y es su propia entrega, con su propio
 * oraculo de frescura, porque el archivo generado pesa medio mega.
 */
declare global {
  namespace Cloudflare {
    interface Env extends Entorno {}
  }
}

/** Una billetera por prueba: el aislamiento lo da el nombre, no el orden. */
function billetera(nombre: string) {
  return env.BILLETERA.get(env.BILLETERA.idFromName(nombre))
}

describe('el SQLite del Durable Object', () => {
  it('existe y guarda lo que se le escribe', async () => {
    const filas = await runInDurableObject(billetera('sql-vive'), (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE t (clave TEXT PRIMARY KEY, monto INTEGER NOT NULL) STRICT')
      ctx.storage.sql.exec("INSERT INTO t (clave, monto) VALUES ('a', 100000)")
      return [...ctx.storage.sql.exec<{ clave: string; monto: number }>('SELECT clave, monto FROM t')]
    })

    expect(filas).toEqual([{ clave: 'a', monto: 100000 }])
  })

  it('aplica STRICT: un entero no acepta texto', async () => {
    // Importa para la entrega siguiente: los guaranies van a vivir en columnas
    // INTEGER, y STRICT es lo que impide que un '100000' de texto entre y ordene
    // como texto. Si esto no se aplicara, la restriccion tendria que estar en
    // TypeScript, del lado de afuera de la unica puerta al dinero.
    const error = await runInDurableObject(billetera('sql-strict'), (_do, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE m (monto INTEGER NOT NULL) STRICT')
      try {
        ctx.storage.sql.exec("INSERT INTO m (monto) VALUES ('cien mil')")
        return null
      } catch (e) {
        return (e as Error).message
      }
    })

    expect(error).not.toBeNull()
  })

  it('aplica CHECK: una bolsa inventada no entra', async () => {
    // `ledger_copia` en D1 ya usa un CHECK para los tipos de bolsa, y
    // `check-esquema.mjs` existe para que TypeScript y ese CHECK no se
    // desincronicen. La entrega siguiente pone el MISMO CHECK adentro del DO,
    // que es donde nace el asiento. Esta prueba confirma que ahi tambien manda.
    const error = await runInDurableObject(billetera('sql-check'), (_do, ctx) => {
      ctx.storage.sql.exec(
        "CREATE TABLE b (tipo TEXT NOT NULL CHECK (tipo IN ('disponible', 'retenido'))) STRICT",
      )
      try {
        ctx.storage.sql.exec("INSERT INTO b (tipo) VALUES ('inventada')")
        return null
      } catch (e) {
        return (e as Error).message
      }
    })

    expect(error).not.toBeNull()
  })
})

describe('la transaccion de storage', () => {
  it('deshace TODA la escritura cuando algo falla en el medio', async () => {
    // Esta es la prueba que habilita la ley 5. El evento del outbox y el asiento
    // se van a escribir en la misma transaccion; lo que hace que eso sea una
    // garantia y no una intencion es que una caida en el medio no deje ni uno de
    // los dos. Se inyecta la caida, igual que el arnes del spike financiero.
    const quedaron = await runInDurableObject(billetera('tx-rollback'), async (_do, ctx) => {
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

    // Ni el asiento solo, ni el evento solo. Ninguno de los dos.
    expect(quedaron.asientos).toEqual([{ n: 0 }])
    expect(quedaron.outbox).toEqual([{ n: 0 }])
  })

  it('confirma las dos escrituras cuando no falla nada', async () => {
    // El par de la prueba de arriba. Una prueba de rollback sola pasaria igual
    // si la transaccion nunca escribiera nada: hay que verificar tambien que el
    // camino sano SI persiste, o no se distingue "deshizo" de "no hizo".
    const quedaron = await runInDurableObject(billetera('tx-commit'), async (_do, ctx) => {
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
})

describe('la alarma del Durable Object', () => {
  it('se programa, se lee y se puede cancelar', async () => {
    // El plan maestro dice que una reserva sin confirmar vence sola, por la
    // alarma del propio DO, sin cron ni barrido. Esto es el mecanismo.
    const vencimiento = Date.parse('2026-08-17T15:00:00Z')

    await runInDurableObject(billetera('alarma-basica'), async (_do, ctx) => {
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

  it('el disparador distingue "habia alarma" de "no habia"', async () => {
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
    const oreja = billetera('alarma-disparador')

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

describe('el Worker desplegado', () => {
  it('/salud contesta y valida el guarani dentro del runtime', async () => {
    // Las 50 pruebas de `tests/` verifican `guaranies()` en Node. Esta lo
    // verifica ADENTRO de workerd, atravesando el fetch, los vars del entorno y
    // el binding — que es el camino que recorre una peticion de verdad.
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
