/**
 * Configuracion de las pruebas que corren DENTRO del runtime de Cloudflare.
 *
 * Van aparte de `vitest.config.ts` a proposito. Las pruebas de `tests/` son del
 * nucleo puro: corren en Node, en milisegundos, y son las que la mutacion ataca
 * decenas de veces. Las de `pruebas-runtime/` levantan workerd. Mezclarlas haria
 * que cada mutacion pague el arranque del runtime, y la mutacion ya se corre 49
 * veces y va a crecer.
 *
 * Lo que esta separacion NO significa: que las pruebas del runtime sean
 * opcionales. `npm run verificar` corre las dos, y el CI llama a `verificar`.
 *
 * Este archivo esta en el `include` de `tsconfig.json`. No es un detalle: la
 * primera version tenia una opcion `singleWorker: true` que la API nueva del
 * pool ya no acepta, y el schema descarta las claves desconocidas EN SILENCIO.
 * Estaba escrita, comentada, explicada — y no hacia nada. Con el archivo dentro
 * del alcance de `tsc`, una opcion inventada no compila.
 */
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import entornoDePruebas from './pruebas-runtime/entorno-de-pruebas.json'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Se lee el wrangler.jsonc de verdad, con el entorno de staging. Un
      // binding inventado aca probaria una configuracion que no existe.
      //
      // El nombre del entorno sale de `pruebas-runtime/entorno-de-pruebas.json`,
      // que tambien lee `check-runtime.mjs` para resolver la fecha de
      // compatibilidad efectiva. Es un archivo de datos y no un literal aca
      // porque asi los dos lados no pueden divergir: la version anterior lo
      // sacaba de ESTE archivo con una expresion regular sobre el TypeScript, y
      // una auditoria la rompio con un glob y con `test.environment`.
      wrangler: { configPath: './wrangler.jsonc', environment: entornoDePruebas.environment },

      // Explicito, aunque el default hoy sea inerte. Con `remoteBindings` en
      // `true` —que es el default— un binding marcado `"remote": true`, o
      // cualquier recurso que no tenga simulador local, saldria a la red de
      // verdad durante las pruebas. Y `mutar.mjs` apunta este archivo a
      // `environment: 'produccion'` durante unos segundos por corrida para
      // comprobar que el entorno no es decorativo: con bindings remotos, el
      // destino de esos segundos seria `core-produccion`. La plata no se prueba
      // contra la base de produccion ni por accidente ni por cuatro segundos.
      remoteBindings: false,
    }),
  ],
  test: {
    include: ['pruebas-runtime/**/*.test.ts'],
    // Determinismo, por la misma razon que en vitest.config.ts.
    sequence: { shuffle: false },
  },
})
