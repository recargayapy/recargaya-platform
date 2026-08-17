/**
 * Configuracion de las pruebas que corren DENTRO del runtime de Cloudflare.
 *
 * Van aparte de `vitest.config.ts` a proposito. Las pruebas de `tests/` son del
 * nucleo puro: corren en Node, en milisegundos, y son las que la mutacion ataca
 * decenas de veces. Las de `pruebas-runtime/` levantan workerd. Mezclarlas haria
 * que cada mutacion pague el arranque del runtime, y la mutacion ya se corre 77
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
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

/**
 * Se lee con `readFileSync` y no con `import ... from './x.json'` a proposito.
 * El import avisaba en CADA corrida —«JSON import without import attributes …
 * Add `with { type: 'json' }`»— y agregar el atributo que pide Vite rompe
 * `npm run tipos` (`TS2823`, porque `module` no es `esnext`). Entre un aviso que
 * se vuelve error cuando Vite cambie el default y un `tsc` en rojo, se lee el
 * archivo. De paso `tsconfig.json` no necesita `resolveJsonModule`.
 */
const arnes = JSON.parse(
  readFileSync(new URL('./pruebas-runtime/arnes-del-runtime.json', import.meta.url), 'utf8'),
) as { configPath: string; environment: string }

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Se lee el wrangler.jsonc de verdad. Un binding inventado aca probaria una
      // configuracion que no existe.
      //
      // La ruta y el entorno salen de `pruebas-runtime/arnes-del-runtime.json`,
      // que leen tambien `check-runtime.mjs` (para resolver la fecha de
      // compatibilidad efectiva de ese entorno) y `check-entorno.mjs` (para
      // generar los tipos de sus bindings). Es un archivo de datos y no literales
      // aca porque asi los tres lados no pueden divergir: una version anterior
      // sacaba el entorno de ESTE archivo con una expresion regular sobre el
      // TypeScript, y una auditoria la rompio con un glob y con `test.environment`.
      wrangler: { configPath: arnes.configPath, environment: arnes.environment },

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
