#!/usr/bin/env node
/**
 * Pruebas con mutacion.
 *
 * El metodo del proyecto lo dice sin ambiguedad: "Toda prueba nueva se valida
 * rompiendo el codigo a proposito: si la prueba no muere, no prueba nada."
 *
 * Esta herramienta rompe el codigo de verdad —una mutacion por vez, en un
 * archivo real, en disco— corre la suite entera, y exige que FALLE. Una
 * mutacion que sobrevive es un agujero en las pruebas, y se reporta como error.
 *
 * "Mutar tambien el arnes": las ultimas mutaciones de la lista atacan el arnes
 * de pruebas, no el codigo de produccion. Un arnes que no puede fallar hace que
 * todo pase.
 *
 * Uso:  node herramientas/mutar.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * Cada mutacion nombra el invariante que ataca. Si alguna sobrevive, el nombre
 * te dice exactamente que dejaste sin probar.
 */
const MUTACIONES = [
  {
    // Nota de la primera pasada de mutacion: quitar SOLO esta linea sobrevivia,
    // porque `isSafeInteger` tambien rechaza los decimales y el codigo seguia
    // tirando `MontoInvalido` por otro camino. `toThrow(MontoInvalido)` no
    // distinguia los dos mensajes. El arreglo no es fusionar la mutacion —eso
    // perderia la granularidad de un invariante por linea— es que
    // `tests/monto.test.ts` verifique el mensaje especifico de ESTA linea.
    invariante: 'el guarani no acepta decimales (mensaje especifico)',
    archivo: 'src/dinero/monto.ts',
    de: "  if (!Number.isInteger(valor)) throw new MontoInvalido(valor, 'el guarani no tiene decimales')\n",
    a: '',
  },
  {
    invariante: 'el reparto no pierde el remanente',
    archivo: 'src/dinero/monto.ts',
    de: '    truncados[i] = (truncados[i] ?? 0) + 1\n    remanente -= 1',
    a: '    remanente -= 1',
  },
  {
    invariante: 'el desempate del reparto es estable',
    archivo: 'src/dinero/monto.ts',
    de: '.sort((a, b) => (b.resto - a.resto) || (a.i - b.i))',
    a: '.sort((a, b) => (a.resto - b.resto) || (a.i - b.i))',
  },
  {
    invariante: 'el credito de promocion se gasta antes que el disponible',
    archivo: 'src/dinero/bolsas.ts',
    de: "const PRECEDENCIA: readonly TipoBolsa[] = ['credito_promocion', 'ganancia_creador', 'disponible']",
    a: "const PRECEDENCIA: readonly TipoBolsa[] = ['disponible', 'ganancia_creador', 'credito_promocion']",
  },
  {
    invariante: 'primero vence, primero se gasta',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (va !== vb) return va < vb ? -1 : 1',
    a: 'if (va !== vb) return va < vb ? 1 : -1',
  },
  {
    invariante: 'una bolsa vencida no se consume',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (bolsa.vence_en !== null && bolsa.vence_en <= momento) continue',
    a: '',
  },
  {
    invariante: 'el credito restringido no sirve para otro proposito',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (bolsa.restringida_a !== null && bolsa.restringida_a !== opciones.proposito) continue',
    a: '',
  },
  {
    invariante: 'la regla anticajero: el credito vuelve con su vencimiento original',
    archivo: 'src/dinero/bolsas.ts',
    de: 'devueltas.push({ ...t.bolsa, monto: guaranies(monto) })',
    a: "devueltas.push({ ...t.bolsa, tipo: 'disponible', vence_en: null, monto: guaranies(monto) })",
  },
  {
    invariante: 'la devolucion es en orden inverso al consumo',
    archivo: 'src/dinero/bolsas.ts',
    de: 'for (let i = tomas.length - 1; i >= 0 && restante > 0; i--) {',
    a: 'for (let i = 0; i < tomas.length && restante > 0; i++) {',
  },
  {
    invariante: 'no se devuelve mas de lo consumido',
    archivo: 'src/dinero/bolsas.ts',
    de: 'if (aDevolver > consumido) {',
    a: 'if (false) {',
  },
  {
    invariante: 'la idempotencia impide el pago doble',
    archivo: 'src/billetera/nucleo.ts',
    de: '  if (previo === undefined) return null',
    a: '  if (previo === undefined || true) return null',
  },
  {
    invariante: 'el ledger cuadra con las bolsas',
    archivo: 'src/billetera/nucleo.ts',
    de: "      throw new Error(`descuadre en ${tipo}: ledger ${delLedger} vs bolsas ${enBolsa}`)",
    a: '',
  },
  {
    invariante: 'ningun asiento se duplica',
    archivo: 'src/billetera/nucleo.ts',
    de: '    if (vistos.has(a.asiento_id)) throw new Error(`asiento duplicado: ${a.asiento_id}`)',
    a: '',
  },
  {
    invariante: 'reservar() registra de que bolsas salio la reserva',
    archivo: 'src/billetera/nucleo.ts',
    de: '    tomas: consumo.tomas,',
    a: '    tomas: [],',
  },
  {
    invariante: 'liberarReserva() devuelve el remanente real, no cero',
    archivo: 'src/billetera/nucleo.ts',
    de: 'const vueltas = devolver(r.tomas, remanente)',
    a: 'const vueltas = devolver(r.tomas, CERO)',
  },
  {
    invariante: 'retenido no se consume en decidirConsumo',
    archivo: 'src/dinero/bolsas.ts',
    de: "const disponiblesParaConsumo = bolsas.filter((b) => b.tipo !== 'retenido')",
    a: 'const disponiblesParaConsumo = bolsas',
  },
  {
    invariante: 'reservar() mueve la plata a retenido, no la debita contra la nada',
    archivo: 'src/billetera/nucleo.ts',
    de: '  const bolsas = [...bolsasSinTomas, ...retenidas]',
    a: '  const bolsas = bolsasSinTomas',
  },
  {
    invariante: 'reservar() rechaza un reserva_id con reserva abierta existente',
    archivo: 'src/billetera/nucleo.ts',
    de: "  if (estado.reservas.get(entrada.reserva_id)?.estado === 'abierta') {\n    throw new Error(`ya existe una reserva abierta con reserva_id: ${entrada.reserva_id}`)\n  }",
    a: '',
  },
  {
    invariante: 'liberarReserva() vacia retenido de la reserva que libera',
    archivo: 'src/billetera/nucleo.ts',
    de: '  const bolsas = [...bolsasSinRetenido, ...vueltas]',
    a: '  const bolsas = [...estado.bolsas, ...vueltas]',
  },
  {
    invariante: 'retenido cuadra con las reservas abiertas',
    archivo: 'src/billetera/nucleo.ts',
    de: '    throw new Error(\n      `descuadre en retenido: bolsas ${retenidoEnBolsas} vs reservas abiertas ${retenidoEnReservas}`,\n    )',
    a: '',
  },
  {
    invariante: 'sin vendedor, su peso no se descarta',
    archivo: 'src/reparto/reparto.ts',
    de: '    : [pesos.creador, pesos.vendedor + pesos.plataforma]',
    a: '    : [pesos.creador, pesos.plataforma]',
  },
  {
    invariante: 'la ganancia del creador no es retirable de inmediato',
    archivo: 'src/reparto/reparto.ts',
    de: "      bolsa: 'ganancia_creador',\n    },\n  ]",
    a: "      bolsa: 'disponible',\n    },\n  ]",
  },
  {
    invariante: 'la clave de idempotencia no incluye el intento',
    archivo: 'src/reparto/reparto.ts',
    de: 'const clave = `${venta.pedido_id}:${nombre}`',
    a: 'const clave = `${venta.pedido_id}:${nombre}:${Math.random()}`',
  },
  {
    // El oraculo de esta mutacion NO es vitest: vitest corre sobre
    // TypeScript, y el CHECK vive en SQL, del otro lado de esa frontera. Es
    // justo la frontera donde se escondio el defecto de la auditoria — el
    // agujero que `check-esquema.mjs` existe para cerrar.
    invariante: 'el CHECK de ledger_copia incluye retenido',
    archivo: 'migraciones/core/0001_cimientos.sql',
    de: "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion', 'retenido'))",
    a: "CHECK (bolsa IN ('disponible', 'ganancia_creador', 'credito_promocion'))",
    oraculo: ['node', 'herramientas/check-esquema.mjs'],
  },
  {
    invariante: 'check-esquema.mjs detecta un tipo de bolsa que le falta al CHECK',
    archivo: 'herramientas/check-esquema.mjs',
    de: 'return { ok: faltantes.length === 0 && sobrantes.length === 0, faltantes, sobrantes }',
    a: 'return { ok: true, faltantes, sobrantes }',
    oraculo: ['node', 'herramientas/check-esquema.pruebas.mjs'],
  },
  {
    invariante: 'acreditar() rechaza bolsa retenido: solo reservar() entra ahi',
    archivo: 'src/billetera/nucleo.ts',
    de: "  if (entrada.bolsa === 'retenido') {\n    throw new Error('retenido no se acredita directo: solo reservar() mueve plata ahi')\n  }",
    a: '',
  },

  // --- Los oraculos nuevos ------------------------------------------------
  // Un oraculo sin jueces fue el defecto n.º 1 de la Fase 0: se rompio la
  // deteccion de descuadre y ninguna prueba se dio cuenta. Estas siete atacan a
  // `check-runtime.mjs` y `check-entorno.mjs`, y su oraculo son las pruebas
  // propias de cada herramienta.
  {
    // EL caso que check-runtime existe para agarrar: sin fecha declarada,
    // miniflare pone la del reloj del sistema. Si el oraculo inventara una, el
    // agujero queda abierto y encima con un OK arriba.
    invariante: 'check-runtime no inventa una fecha cuando no hay ninguna declarada',
    archivo: 'herramientas/check-runtime.mjs',
    de: '  return { fecha: null, origen: null }\n}',
    a: "  return { fecha: '2026-08-01', origen: 'inventada' }\n}",
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    // La fecha de `env.<entorno>` gana sobre la de la raiz, porque es la que usa
    // wrangler. La version anterior de esta herramienta declaraba el caso un
    // conflicto irresoluble y fallaba.
    invariante: 'check-runtime resuelve la fecha del entorno por sobre la de la raiz',
    archivo: 'herramientas/check-runtime.mjs',
    de: "  if (typeof delEntorno === 'string') return { fecha: delEntorno, origen: `env.${entorno}` }",
    a: '',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    // Un comentario de bloque con una fecha vieja adentro no es una fecha. El
    // extractor anterior —lineas que arrancan con `//`— la tomaba como valida.
    invariante: 'check-runtime no toma como fecha la que vive en un comentario de bloque',
    archivo: 'herramientas/check-runtime.mjs',
    de: "    if (c === '/' && d === '*') {",
    a: '    if (false) {',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    // Una barra doble adentro de una cadena no abre un comentario. Sin esta
    // rama, una URL en la configuracion se come el resto de la linea.
    invariante: 'check-runtime sabe cuando esta adentro de una cadena',
    archivo: 'herramientas/check-runtime.mjs',
    de: "    if (c === '\"') {\n      enCadena = true",
    a: '    if (false) {\n      enCadena = true',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    // `2026-02-30` no existe y JavaScript la corre en silencio a 2026-03-02.
    invariante: 'check-runtime rechaza una fecha que no existe',
    archivo: 'herramientas/check-runtime.mjs',
    de: "  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(fecha)",
    a: '  return true',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    // El guard del CLI. Con el anterior —por nombre de archivo— invocarlo por un
    // symlink importaba el modulo, no verificaba nada y salia con 0: el peor
    // final posible para un oraculo. Las pruebas de punta a punta lo cubren.
    invariante: 'check-runtime corre de verdad cuando se lo invoca',
    archivo: 'herramientas/check-runtime.mjs',
    de: 'if (import.meta.main) main()',
    a: 'if (false) main()',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    invariante: 'check-entorno detecta que los tipos generados no coinciden',
    archivo: 'herramientas/check-entorno.mjs',
    de: "  if (a === b) return { ok: true, lineaDistinta: null, esperada: null, encontrada: null }",
    a: '  return { ok: true, lineaDistinta: null, esperada: null, encontrada: null }',
    oraculo: ['node', 'herramientas/check-entorno.pruebas.mjs'],
  },
  {
    // La normalizacion del encabezado tiene que sacar UNA linea, no todos los
    // comentarios: si sacara cualquier `//`, una edicion a mano al final de una
    // linea de codigo pasaria inadvertida, que es justo el caso que
    // `wrangler types --check` no agarra y por el que existe esta herramienta.
    invariante: 'check-entorno normaliza solo el encabezado, no todo comentario',
    archivo: 'herramientas/check-entorno.mjs',
    de: "      .replace(/^\\/\\/ Generated by Wrangler by running .*$/m, '// (encabezado de wrangler)')",
    a: "      .replace(/\\/\\/.*$/gm, '// (encabezado de wrangler)')",
    oraculo: ['node', 'herramientas/check-entorno.pruebas.mjs'],
  },

  // --- Las pruebas del Durable Object -------------------------------------
  // Su oraculo NO es vitest a secas: las pruebas del runtime viven en otra
  // configuracion porque levantan workerd, y no tiene sentido pagar ese arranque
  // en cada una de las mutaciones de arriba.
  //
  // Decir lo que falta: de las doce pruebas de `pruebas-runtime/`, solo las dos
  // de `/salud` estan ancladas a codigo de `src/`. Las otras diez son sondas de
  // la plataforma y no hay linea de produccion que romper para matarlas. Esta
  // lista NO prueba que esas diez sirvan; el encabezado de
  // `pruebas-runtime/runtime.test.ts` dice que tiene que hacer la entrega
  // siguiente para cerrarlo.
  {
    invariante: 'la prueba de /salud lee los vars del entorno de verdad',
    archivo: 'src/index.ts',
    de: '        entorno: entorno.ENTORNO,',
    a: "        entorno: 'produccion',",
    oraculo: ['npx', 'vitest', 'run', '--config', 'vitest.runtime.config.ts', '--silent'],
  },
  {
    invariante: 'una ruta desconocida da 404 y no otra cosa',
    archivo: 'src/index.ts',
    de: "    return new Response('no encontrado', { status: 404 })",
    a: "    return new Response('no encontrado', { status: 500 })",
    oraculo: ['npx', 'vitest', 'run', '--config', 'vitest.runtime.config.ts', '--silent'],
  },

  // --- Mutar tambien el arnes ---------------------------------------------
  // Un arnes que no puede fallar hace que todo pase. Si estas sobreviven, las
  // pruebas no estan probando la caida: estan probando nada.
  {
    invariante: 'el arnes inyecta la caida de verdad',
    archivo: 'tests/arnes.ts',
    de: "      throw new CaidaInyectada('despues', paso.nombre)",
    a: '',
  },
  {
    invariante: 'el arnes reanuda desde el paso que fallo, no desde cero',
    archivo: 'tests/arnes.ts',
    de: '    if (completados.has(paso.nombre)) continue',
    a: '',
  },
  {
    // `vitest.runtime.config.ts` dice que las pruebas leen el entorno `staging`
    // del wrangler.jsonc de verdad; si eso fuera decorativo, las doce pruebas
    // correrian contra una configuracion inventada y nadie se enteraria.
    invariante: 'el arnes del runtime lee el entorno que dice leer',
    archivo: 'vitest.runtime.config.ts',
    de: "      wrangler: { configPath: './wrangler.jsonc', environment: 'staging' },",
    a: "      wrangler: { configPath: './wrangler.jsonc', environment: 'produccion' },",
    oraculo: ['npx', 'vitest', 'run', '--config', 'vitest.runtime.config.ts', '--silent'],
  },
  {
    // El arnes tiene que poder apagarse ruidosamente. Hoy un `include` que no
    // machea sale con 1 ("No test files found"); el dia que alguien agregue
    // `passWithNoTests: true` para callar un ruido, esta mutacion SOBREVIVE y
    // avisa que `verificar` esta saliendo verde con cero pruebas del runtime.
    invariante: 'el arnes del runtime falla si no encuentra pruebas',
    archivo: 'vitest.runtime.config.ts',
    de: "    include: ['pruebas-runtime/**/*.test.ts'],",
    a: "    include: ['pruebas-runtime/**/*.no-existe.ts'],",
    oraculo: ['npx', 'vitest', 'run', '--config', 'vitest.runtime.config.ts', '--silent'],
  },
  {
    // El aislamiento entre pruebas del runtime es una convencion: cada prueba usa
    // su propio nombre de Durable Object. Medido: en esta version del pool el
    // storage NO se resetea entre pruebas del mismo archivo, y no hay opcion que
    // lo haga. Una convencion sin oraculo se rompe sola.
    invariante: 'el aislamiento entre pruebas del runtime lo da el nombre del DO',
    archivo: 'pruebas-runtime/runtime.test.ts',
    de: '  return env.BILLETERA.get(env.BILLETERA.idFromName(nombreDeLaPrueba))',
    a: "  return env.BILLETERA.get(env.BILLETERA.idFromName('una-sola'))",
    oraculo: ['npx', 'vitest', 'run', '--config', 'vitest.runtime.config.ts', '--silent'],
  },
]

let sobrevivientes = []
let muertas = 0

console.log(`\n  Mutacion — ${MUTACIONES.length} invariantes bajo ataque\n`)

for (const m of MUTACIONES) {
  const original = readFileSync(m.archivo, 'utf8')

  if (!original.includes(m.de)) {
    console.log(`  ?  ${m.invariante}`)
    console.log(`     LA MUTACION NO APLICA — el fragmento ya no existe en ${m.archivo}.`)
    console.log(`     Una mutacion que no muta no prueba nada. Actualizala.\n`)
    sobrevivientes.push(`${m.invariante} (fragmento inexistente)`)
    continue
  }

  writeFileSync(m.archivo, original.replace(m.de, m.a))

  // El oraculo por defecto es vitest. Algunas mutaciones atacan un lugar que
  // vitest no ve — el CHECK de una migracion SQL, o una herramienta de node
  // plano — y declaran su propio oraculo en vez de fingir que vitest las
  // cubre.
  const [cmd, ...args] = m.oraculo ?? ['npx', 'vitest', 'run', '--silent']

  let murio = false
  try {
    execFileSync(cmd, args, { stdio: 'pipe' })
  } catch {
    murio = true // el oraculo fallo: la mutacion murio, que es lo que queremos
  } finally {
    writeFileSync(m.archivo, original)
  }

  if (murio) {
    muertas += 1
    console.log(`  ✓  ${m.invariante}`)
  } else {
    sobrevivientes.push(m.invariante)
    console.log(`  ✗  ${m.invariante}`)
    console.log(`     SOBREVIVIO — rompimos esto a proposito y ninguna prueba se dio cuenta.\n`)
  }
}

console.log(`\n  ${muertas}/${MUTACIONES.length} mutaciones muertas`)

if (sobrevivientes.length > 0) {
  console.log(`\n  ${sobrevivientes.length} sobrevivieron. Cada una es un agujero en las pruebas:\n`)
  for (const s of sobrevivientes) console.log(`    · ${s}`)
  console.log('')
  process.exit(1)
}

console.log('  Todas murieron. Las pruebas prueban algo.\n')
