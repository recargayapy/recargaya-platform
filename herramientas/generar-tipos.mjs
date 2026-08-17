#!/usr/bin/env node
/**
 * Regenera `worker-configuration.d.ts` desde `wrangler.jsonc`.
 *
 * Existe para que el comando viva en UN solo lugar. `check-entorno.mjs` exporta
 * los argumentos con los que compara; si `package.json` los repitiera a mano, el
 * dia que uno de los dos cambie el oraculo estaria comparando contra algo que
 * nadie genera — que es justo la clase de deriva que ese oraculo existe para
 * cerrar, aplicada a el mismo.
 *
 * Uso:  npm run tipos:generar
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ARGUMENTOS, GENERADO } from './check-entorno.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

const r = spawnSync('npx', [...ARGUMENTOS, GENERADO], {
  cwd: RAIZ,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

process.exit(r.status ?? 1)
