# RecargaYA Platform 2.0

Plataforma paraguaya de recargas, servicios digitales y contenido de creadores,
construida sobre Cloudflare.

**Fase 0 — Fundaciones y el spike financiero.**

## Qué hay acá

```
src/dinero/       guaraníes enteros, bolsas, precedencia de consumo (ley 4 y 11)
src/billetera/    el núcleo de la billetera: asientos, idempotencia, invariantes
src/reparto/      el spike: repartir una venta entre cuatro billeteras
src/index.ts      el Worker y los dos Durable Objects
migraciones/core/ el esquema de D1, versionado desde la primera tabla
tests/            50 pruebas del núcleo puro, incluido el arnés de caídas
pruebas-runtime/  las que corren sobre workerd, el motor real de Cloudflare
herramientas/     los oráculos y la mutación: rompe el código y exige que falle
```

## Correr la verificación

```bash
npm install
npm run verificar
```

Los seis oráculos tienen que pasar. Es lo mismo que corre el CI, que llama a
`npm run verificar` y no a cada uno por separado — así un oráculo nuevo entra sin
que nadie toque el workflow.

| Comando | Qué hace |
|---|---|
| `npm run entorno` | que los tipos de los bindings sean lo que genera `wrangler.jsonc` |
| `npm run tipos` | TypeScript estricto, sin emitir |
| `npm run probar` | las 50 pruebas del núcleo puro, en Node |
| `npm run esquema` | los tipos de TypeScript contra el SQL de las migraciones |
| `npm run runtime` | que la fecha de compatibilidad esté escrita, y 14 pruebas sobre workerd |
| `npm run mutar` | rompe 53 invariantes a propósito y exige que todos mueran |
| `npm run desarrollo` | Wrangler local contra staging |

Los números de esta tabla envejecen. Los que manda son los que imprime
`npm run verificar`; el detalle del método está en `CLAUDE.md`.

## El spike financiero

El problema que resuelve: una venta toca cuatro saldos —cliente, creador,
vendedor y plataforma— y en Cloudflare cada billetera es un Durable Object
distinto. **No hay transacción que los abarque.** Si el Worker muere entre el
paso dos y el tres, el cliente ya pagó y el creador todavía no cobró.

La respuesta: un Workflow con pasos idempotentes. Cada paso llama a una
billetera con una clave que identifica **la intención**, no el momento; la
billetera rechaza el duplicado; el Workflow reintenta **el paso que falló**, no
el proceso entero.

Las pruebas inyectan una caída en cada uno de los cuatro pasos, de dos formas
distintas —antes de aplicar, y **después de aplicar pero antes de registrarlo**,
que es el caso que rompe los sistemas mal diseñados— y verifican que nunca se
paga dos veces ni se pierde un guaraní.

## Primer despliegue

Ver [`docs/PRIMER-DESPLIEGUE.md`](docs/PRIMER-DESPLIEGUE.md).

## Cómo se trabaja acá

Ver [`CLAUDE.md`](CLAUDE.md): las doce leyes, el método y las reglas del
repositorio.
