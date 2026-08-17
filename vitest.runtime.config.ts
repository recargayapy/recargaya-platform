/**
 * Configuracion de las pruebas que corren DENTRO del runtime de Cloudflare.
 *
 * Van aparte de `vitest.config.ts` a proposito. Las pruebas de `tests/` son del
 * nucleo puro: corren en Node, en milisegundos, y son las que la mutacion ataca
 * cientos de veces. Las de `pruebas-runtime/` levantan workerd. Mezclarlas
 * haria que cada mutacion pague el arranque del runtime — y la mutacion se
 * corre 28 veces y va a crecer.
 *
 * Lo que esta separacion NO significa: que las pruebas del runtime sean
 * opcionales. `npm run verificar` corre las dos, y el CI llama a `verificar`.
 */
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Un solo runtime para todo el archivo: mas rapido, y el aislamiento entre
      // pruebas lo da que cada una usa su propio nombre de Durable Object.
      singleWorker: true,
      // Se lee el wrangler.jsonc de verdad, con el entorno de staging. Un
      // binding inventado aca probaria una configuracion que no existe.
      wrangler: { configPath: './wrangler.jsonc', environment: 'staging' },
    }),
  ],
  test: {
    include: ['pruebas-runtime/**/*.test.ts'],
    // Determinismo, por la misma razon que en vitest.config.ts.
    sequence: { shuffle: false },
  },
})
