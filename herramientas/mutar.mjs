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
    de: '    tomas: d.valor.tomas,',
    a: '    tomas: [],',
  },
  {
    invariante: 'liberarReserva() devuelve el remanente real, no cero',
    archivo: 'src/billetera/nucleo.ts',
    de: 'const vueltas = devolver(r.tomas, remanente)',
    a: 'const vueltas = devolver(r.tomas, CERO)',
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

  // --- Mutar tambien el arnes ---------------------------------------------
  // Un arnes que no puede fallar hace que todo pase. Si estas dos sobreviven,
  // las pruebas del spike no estan probando la caida: estan probando nada.
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

  let murio = false
  try {
    execFileSync('npx', ['vitest', 'run', '--silent'], { stdio: 'pipe' })
  } catch {
    murio = true // la suite fallo: la mutacion murio, que es lo que queremos
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
