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

  // --- El oraculo del runtime ---------------------------------------------
  // Estas tres atacan a `check-runtime.mjs`, el oraculo que impide que las
  // pruebas del Durable Object juzguen sobre un workerd distinto al que
  // Cloudflare ejecuta. Un oraculo sin jueces fue el defecto n.º 1 de la Fase 0:
  // se rompio la deteccion de descuadre y ninguna prueba se dio cuenta.
  {
    invariante: 'check-runtime detecta que la compatibility_date supera al workerd instalado',
    archivo: 'herramientas/check-runtime.mjs',
    de: '  const ok = fechaCompatibilidad <= fechaWorkerd',
    a: '  const ok = true',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    // Sin esta guarda, `1.20260230.0` daba "2026-02-30", que JavaScript corre en
    // silencio a 2026-03-02: el oraculo comparaba contra una fecha que nadie
    // escribio, y no tenia forma de notarlo.
    invariante: 'check-runtime rechaza una version que no codifica una fecha real',
    archivo: 'herramientas/check-runtime.mjs',
    de: '  if (Number.isNaN(d.getTime()) || !d.toISOString().startsWith(fecha)) {',
    a: '  if (false) {',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },
  {
    // Con dos fechas activas en wrangler.jsonc, elegir una es adivinar — y
    // adivinar es lo que produce el defecto que este oraculo existe para agarrar.
    invariante: 'check-runtime falla si wrangler.jsonc declara dos compatibility_date',
    archivo: 'herramientas/check-runtime.mjs',
    de: '  if (encontradas.length > 1) {',
    a: '  if (false) {',
    oraculo: ['node', 'herramientas/check-runtime.pruebas.mjs'],
  },

  // --- Las pruebas del Durable Object -------------------------------------
  // Su oraculo NO es vitest a secas: las pruebas del runtime viven en otra
  // configuracion porque levantan workerd, y no tiene sentido pagar ese arranque
  // en cada una de las mutaciones de arriba. Si estas dos sobreviven, las nueve
  // pruebas de `pruebas-runtime/` estan mirando para otro lado.
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
    // El arnes del runtime tambien se muta. `vitest.runtime.config.ts` dice que
    // las pruebas leen el entorno `staging` del wrangler.jsonc de verdad; si eso
    // fuera decorativo, las nueve pruebas correrian contra una configuracion
    // inventada y nadie se enteraria. Apuntandolo a `produccion`, la prueba de
    // /salud —que exige `entorno: 'staging'`— tiene que morir.
    invariante: 'el arnes del runtime lee el entorno que dice leer',
    archivo: 'vitest.runtime.config.ts',
    de: "      wrangler: { configPath: './wrangler.jsonc', environment: 'staging' },",
    a: "      wrangler: { configPath: './wrangler.jsonc', environment: 'produccion' },",
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
