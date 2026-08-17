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

Corre los cinco oráculos, en este orden:

| | |
|---|---|
| `tipos` | `tsc --noEmit` |
| `probar` | las pruebas del núcleo puro, en Node |
| `esquema` | los tipos de TypeScript contra el SQL de las migraciones |
| `runtime` | que el workerd instalado no sea más viejo que la `compatibility_date`, y las pruebas del Durable Object sobre workerd |
| `mutar` | rompe el código a propósito; toda mutación tiene que morir |

Los cinco tienen que pasar. El CI llama a `npm run verificar` y **no** a cada
oráculo por separado: así el CI y la máquina de cualquiera corren exactamente lo
mismo, y un oráculo nuevo entra sin que nadie toque el workflow.

### Dos suites de pruebas, y por qué

`tests/` prueba el núcleo puro en Node: milisegundos, y es lo que la mutación
ataca decenas de veces. `pruebas-runtime/` levanta **workerd**, el motor real de
Cloudflare, y ahí va todo lo que toca el Durable Object — su SQLite, sus
alarmas, y el rollback de la transacción de storage que hace cumplir la ley 5.

La regla que decide dónde va una prueba: **la plata no se prueba contra una
imitación.** Si algo depende de un mecanismo de Cloudflare, va en
`pruebas-runtime/` y corre sobre el mecanismo. Fabricar un doble de la storage
sería un doble más permisivo que el original, y probaría el doble.

```bash
npm run probar:runtime    # sólo las del runtime, mientras se trabaja
```

**El runtime de prueba tiene que ser el del despliegue.** Si la
`compatibility_date` de `wrangler.jsonc` es posterior a la fecha del workerd
instalado, miniflare la baja en silencio y las pruebas juzgan sobre otro motor.
`herramientas/check-runtime.mjs` lo mide y falla. Se arregla **subiendo
wrangler**, nunca bajando la `compatibility_date`.

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
