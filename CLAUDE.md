# RecargaYA Platform 2.0 — instrucciones del repositorio

Este archivo lo lee cualquier sesión de Claude que trabaje sobre este árbol,
acá o dentro de un pull request. Es la ley del repositorio.

## Idioma

**Todo en castellano rioplatense** — código, comentarios, commits, pull
requests y conversación. Voseo. Los nombres de funciones, tablas y archivos van
en castellano cuando describen negocio (`decidirConsumo`, `saldoRetirable`).
Las APIs de Cloudflare y los términos técnicos establecidos quedan como son.

**Explicar el porqué antes del qué.** El dueño del proyecto no programa:
entiende perfectamente las decisiones cuando se le explica qué problema
resuelven.

## Las doce leyes de la plataforma

Cada una existe porque su ausencia produjo un defecto real. No son estilo.

1. El panel **nunca** consulta el almacén transaccional. Lee el read model.
2. Un asiento del ledger **nunca se edita**. Se compensa con otro asiento.
3. **Sólo el Wallet DO escribe asientos.** Nadie más tiene la capacidad.
4. **"Qué está vigente / qué se consume en este instante" es una función
   pura**, con precedencia declarada y probada contra casos superpuestos.
   Nunca un `ORDER BY`.
5. Todo evento se escribe **en la misma transacción** que el cambio (outbox).
6. **Todo consumidor de eventos es idempotente.** El publicador entrega doble.
7. El texto **nunca** vive dentro de una imagen.
8. Todo destino de CTA o redirección es un **nombre de ruta enumerado** o un
   dominio en lista blanca. Nunca una URL editable.
9. Ninguna API devuelve **datos personales** a la capa de inteligencia.
10. Todo espacio pago va **marcado visiblemente** y respeta un tope por
    pantalla. El embudo transaccional no se alquila.
11. **La plata regalada nunca se convierte en plata retirable.** Un crédito
    vuelve como crédito, con su vencimiento original.
12. Nada llega a producción sin pasar por staging **y sin las dos vueltas de
    auditoría adversarial**.

## Método — no negociable

**Se arregla la categoría del defecto, nunca el caso.** Si un lugar tiene el
problema, buscar los otros catorce antes de tocar nada.

**Medir, no razonar.** Contar archivos, correr la consulta, sacar la captura.
Una afirmación sobre el código que no se midió es una hipótesis.

**Un comentario que promete lo que el código no hace es peor que el defecto
que describe.** Es la causa raíz declarada del proyecto.

**Pruebas con mutación, antes de entregar.** Toda prueba nueva se valida
rompiendo el código a propósito: si la prueba no muere, no prueba nada. Mutar
también el arnés. Se corre con `npm run mutar`, y toda mutación nueva se agrega
a `herramientas/mutar.mjs`.

**Un doble más débil, más fuerte o más permisivo que el original prueba el
doble, no el código.**

**Auditoría adversarial en dos vueltas antes de cada entrega.** La primera
audita el código; **la segunda audita los arreglos de la primera**. En este
proyecto la segunda vuelta encontró un defecto nacido del arreglo en 23 de 24
entregas.

**No mezclar cambios funcionales con cambios visuales en la misma entrega.**

**Decir lo que falta.** Si una entrega no tiene la segunda vuelta de auditoría,
se avisa antes de entregarla, no después.

## Antes de entregar

```bash
npm run verificar
```

Corre los siete oráculos, en este orden:

| | |
|---|---|
| `entorno` | que `worker-configuration.d.ts` sea exactamente lo que genera `wrangler.jsonc` |
| `tipos` | `tsc --noEmit` |
| `probar` | las pruebas del núcleo puro, en Node |
| `esquema` | los tipos de TypeScript contra el SQL de las migraciones |
| `portabilidad` | que ninguna herramienta lance un comando por nombre |
| `runtime` | que la `compatibility_date` del entorno de pruebas esté escrita, y las pruebas del Durable Object sobre workerd |
| `mutar` | rompe el código a propósito; toda mutación tiene que morir |

Los siete tienen que pasar. El CI llama a `npm run verificar` y **no** a cada
oráculo por separado: así el CI y la máquina de cualquiera corren exactamente lo
mismo, y un oráculo nuevo entra sin que nadie toque el workflow.

Cuatro de los siete existen para cubrir una **frontera** donde `tsc` no llega, y
son la misma idea aplicada cuatro veces:

| Frontera | Oráculo |
|---|---|
| TypeScript ↔ el SQL de las migraciones | `check-esquema.mjs` |
| TypeScript ↔ los bindings de `wrangler.jsonc` | `check-entorno.mjs` |
| El arnés de pruebas ↔ el runtime con el que corre | `check-runtime.mjs` |
| Nuestras herramientas ↔ el sistema operativo | `check-portabilidad.mjs` |

Cuando aparezca una frontera nueva, el patrón es ése: una herramienta de Node
plano, con funciones puras exportadas, sus pruebas propias en
`*.pruebas.mjs`, y su mutación en `mutar.mjs`.

### Dos suites de pruebas, y por qué

`tests/` prueba el núcleo puro en Node: milisegundos, y es lo que la mutación
ataca decenas de veces. `pruebas-runtime/` levanta **workerd**, el motor real de
Cloudflare, y ahí va todo lo que toca el Durable Object — su SQLite, sus alarmas
y el rollback de la transacción de storage.

La regla que decide dónde va una prueba: **la plata no se prueba contra una
imitación.** Si algo depende de un mecanismo de Cloudflare, va en
`pruebas-runtime/` y corre sobre el mecanismo. Fabricar un doble de la storage
sería un doble más permisivo que el original, y probaría el doble.

```bash
npm run probar:runtime    # sólo las del runtime, mientras se trabaja
```

**Una prueba de `pruebas-runtime/` no vale por estar ahí.** Una auditoría midió
que, de las que hay hoy, sólo dos están ancladas a código de `src/`; unas pocas
más cubren una convención de este árbol, y el resto son **sondas de la
plataforma**: verifican que Cloudflare se comporta como suponemos, no que nuestro
código lo use. Medido: si el `BilleteraDO` escribiera el asiento y el evento del
outbox en dos `exec` sueltos, sin transacción, todas pasarían igual — **la ley 5
todavía no tiene oráculo.** El encabezado de `pruebas-runtime/runtime.test.ts`
lleva el reparto exacto.

De ahí la regla para las que vengan:

> Si el DDL, la transacción o la alarma viven dentro de la prueba, la prueba es
> una sonda. Para que sea un oráculo, eso tiene que vivir en `src/`, exportado, y
> la prueba tiene que ejecutar **eso** — recién entonces hay una línea que la
> mutación puede romper.

**El aislamiento entre pruebas del runtime es una convención.** No hay reseteo de
storage entre pruebas del mismo archivo en esta versión del pool: cada prueba usa
un Durable Object cuyo nombre sale del **camino completo** de la prueba —
`task.fullName`, no `task.name`, porque dos `it` con el mismo texto en dos
`describe` distintos colisionaban. Hay dos pruebas homónimas a propósito y una
mutación que lo rompe, para que la convención no sea sólo una promesa.

**Ninguna prueba lleva una fecha absoluta cableada.** Una que decía
`Date.parse('2026-08-17T15:00:00Z')` pasó a las 13:53 UTC y falló a las 15:11 del
mismo día. Un instante futuro se calcula, no se escribe.

**La `compatibility_date` del entorno de pruebas tiene que estar escrita.** Si
falta, miniflare pone la fecha de **hoy del reloj del sistema** y el mismo commit
pasa hoy y falla el miércoles. `herramientas/check-runtime.mjs` lo mide y falla.
Un comentario no cuenta como fecha.

**Con qué configuración y con qué entorno corre el arnés del runtime vive en
`pruebas-runtime/arnes-del-runtime.json`,** y no en literales repartidos. Lo leen
tres lados: el arnés, `check-runtime.mjs` y `check-entorno.mjs`. Un dato que tres
archivos necesitan y cada uno escribe a mano deriva; un archivo de datos no puede.
Antes de esto, un oráculo sacaba el nombre del entorno parseando el TypeScript del
arnés con una expresión regular, y un glob `'src/**'` alcanzaba para romperlo.

**Windows no es un detalle de despliegue: es la máquina del dueño.** Todo lo que
esta sesión verifica corre en Linux, así que un defecto que sólo aparece en Windows
pasa las tres vueltas de auditoría sin que nadie lo vea. Ya pasó dos veces —`npx`
que en Windows es `npx.cmd`, y un symlink de directorio que ahí pide permisos de
administrador—. La regla que quedó: **cualquier cosa que toque el sistema de
archivos o lance un proceso se escribe de la forma que anda en las tres
plataformas**, no de la que anda acá.

**Ningún número va escrito en un comentario si se puede contar.** Tres vueltas de
auditoría seguidas encontraron números viejos en la prosa — «cuatro pruebas» cuando
eran nueve, «28 mutaciones» cuando eran 34, «15 nuevas» cuando eran 10. Los que
manda son los que imprime `npm run verificar`; en la prosa va un puntero al lugar
único donde el reparto está escrito.

## Reglas del repositorio

**Nunca subir secretos.** Los secretos de la aplicación van con
`wrangler secret put`. `.dev.vars` está en `.gitignore` desde el primer commit.
Un secreto subido queda en la historia para siempre: si pasa, hay que
**rotarlo**, no borrarlo.

**Staging siempre primero.** Producción sólo con aprobación explícita.

**Nada entra a `main` sin aprobación del dueño.** La descripción del pull
request es el documento de verificación de la entrega: lleva el qué y el
porqué.

## Moneda y tiempo

Guaraníes, **enteros, sin decimales**. Los precios incluyen IVA.
Zona horaria de presentación: `America/Asuncion`. Almacenamiento: UTC, ISO-8601.
