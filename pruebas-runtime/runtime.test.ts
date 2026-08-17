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
 * De las catorce pruebas de este archivo:
 *
 *   · DOS estan ancladas a codigo de `src/` — las de `el Worker desplegado` — y
 *     hay una mutacion de `src/index.ts` que mata a cada una.
 *   · CUATRO —las dos de aislamiento y las dos homonimas— prueban una convencion
 *     de este archivo y no una linea de produccion. TRES de las cuatro mueren por
 *     su propia asercion con una mutacion del arnes; la cuarta (`el estado
 *     sobrevive dentro de una misma prueba`) es el estado que las otras necesitan
 *     y no la mata ninguna mutacion. La tercera vuelta de auditoria midio que la
 *     version anterior de este parrafo decia «las cubre» de las cuatro, y de las
 *     cuatro morian dos.
 *   · Las OCHO restantes son SONDAS DE LA PLATAFORMA: crean sus propias tablas y
 *     le hablan a la API de Cloudflare. Verifican que los mecanismos se comportan
 *     como la entrega siguiente va a suponer, y no pueden verificar que nuestro
 *     codigo los use, porque todavia no hay codigo nuestro que los use.
 *
 * Lo dice una auditoria de esta entrega, y queda escrito para que nadie lea
 * "53/53 mutaciones muertas" como si las catorce estuvieran cubiertas:
 *
 *   Si `BilleteraDO` escribiera el asiento y el evento del outbox en dos `exec`
 *   sueltos, sin transaccion, las catorce pruebas de este archivo pasarian igual.
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

describe('el SQLite del Durable Object', () => {
  it('existe y guarda lo que se le escribe', async ({ task }) => {
    const filas = await runInDurableObject(billetera(task), (_do, ctx) => {
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
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
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
    const r = await runInDurableObject(billetera(task), (_do, ctx) => {
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
    const quedaron = await runInDurableObject(billetera(task), async (_do, ctx) => {
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
    const quedaron = await runInDurableObject(billetera(task), async (_do, ctx) => {
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
