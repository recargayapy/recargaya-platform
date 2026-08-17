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
import { argumentos, GENERADO } from './check-entorno.mjs'
import { comando } from './binarios.mjs'
import { leerArnesDesde } from './arnes-del-runtime.mjs'

const RAIZ = fileURLToPath(new URL('..', import.meta.url))

// Nota: este archivo importa `check-entorno.mjs`, y hubo una version del guard del
// CLI en la que ese import corria `main()` del oraculo — que, cuando los tipos no
// coincidian, hacia `process.exit(1)` antes de generar y dejaba al generador
// incapaz de arreglar al oraculo. Ver `invocado-directo.mjs`.
const args = argumentos(leerArnesDesde(RAIZ).environment)
const [ejecutable, ...resto] = comando('wrangler', ...args, GENERADO)

const r = spawnSync(ejecutable, resto, { cwd: RAIZ, stdio: 'inherit' })

process.exit(r.status ?? 1)
