# Primer despliegue

Se hace **una sola vez**. Después, cada merge a `main` despliega solo a staging.

## Antes de empezar

Hay dos formas de autenticarse. **La primera es la recomendada**, porque no hay
ningún secreto que copiar, pegar ni guardar en ningún lado:

```bash
npx wrangler login     # abre el navegador, autorizás, y queda guardado en disco
```

La segunda es con un token acotado, que es lo que usa el CI:

```bash
export CLOUDFLARE_API_TOKEN="..."     # el token acotado a staging
export CLOUDFLARE_ACCOUNT_ID="..."    # el hexadecimal de 32 caracteres
```

> **En Windows, PowerShell.** `export` es de bash y no hace nada acá. El
> equivalente es `$env:CLOUDFLARE_API_TOKEN = "..."`, y sólo vale para esa
> ventana. Además `npx` a secas puede fallar por la política de ejecución:
> usá **`npx.cmd`**.

Comprobalo:

```bash
npx wrangler whoami
```

Si dice *"You are not authenticated"*, no estás logueado ni tenés las variables
cargadas en esa terminal.

## 1 · Crear las dos bases de D1

Separadas a propósito. Si staging y producción compartieran base, una prueba en
staging movería plata de verdad.

```bash
npx wrangler d1 create core-staging
npx wrangler d1 create core-produccion
```

Cada comando imprime un `database_id`. **Copialos a `wrangler.jsonc`**, en
lugar de los dos `PENDIENTE-crear-con-wrangler-d1-create`.

El `database_id` no es un secreto: va versionado, como corresponde.

## 2 · Aplicar la migración

Primero en local, para ver que corre sin errores:

```bash
npm run migrar:local
```

Después, contra staging de verdad:

```bash
npm run migrar:staging
```

## 3 · Desplegar

```bash
npm run desplegar:staging
```

Wrangler imprime la URL. Comprobá que quedó vivo:

```bash
curl https://recargaya-staging.TU-SUBDOMINIO.workers.dev/salud
```

Tiene que responder `{"estado":"vivo","entorno":"staging",...}`.

**Por qué staging tiene una URL `workers.dev` y producción no.** En
`wrangler.jsonc`, el entorno `staging` declara `"workers_dev": true` y el
entorno `produccion` declara `"workers_dev": false`. Esa opción controla una
sola cosa: si el Worker se publica en `<nombre>.<subdominio>.workers.dev`.

Staging la necesita porque sin una URL pública no hay nada contra qué hacer
este `curl` — ni el CI podría comprobar `/salud` después de desplegar.
Producción no la quiere: va a vivir en un dominio propio, y una `workers.dev`
abierta al mundo sería una segunda puerta a la misma plata, sin el dominio
delante.

Fijate que la respuesta diga `"entorno":"staging"`. Si dijera `"produccion"`,
el despliegue se fue al lugar equivocado.

## 4 · Dejar que el CI lo haga solo de acá en adelante

En **GitHub → Settings → Secrets and variables → Actions**:

**Secrets** (pestaña *Secrets*):

| Nombre | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | el mismo token |
| `CLOUDFLARE_ACCOUNT_ID` | el mismo Account ID |
| `ANTHROPIC_API_KEY` | sólo si querés que `@claude` funcione en los PR |

**Variables** (pestaña *Variables*, no *Secrets*):

| Nombre | Valor |
|---|---|
| `SUBDOMINIO_WORKERS` | tu subdominio de workers.dev, sin `.workers.dev` |

Desde ahí, cada merge a `main` corre los oráculos y despliega a staging solo si
pasan. Lo hace `.github/workflows/desplegar-staging.yml`, en un único job
encadenado: verificar → migrar → desplegar → comprobar `/salud`. Si
`npm run verificar` falla, los pasos siguientes no llegan a correr.

Sin `SUBDOMINIO_WORKERS` el despliegue igual sale, pero el CI avisa con un
warning que **no comprobó** que el Worker responda. Desplegado y desplegado-y-
comprobado no son lo mismo.

## Producción

**No se despliega desde el CI.** Es deliberado: producción va con aprobación
explícita tuya, cuando el sistema esté listo. El comando existe y es
`npm run desplegar:produccion`, pero no debería correrse todavía.

---

## Lo que NO va acá

Los secretos de la aplicación —D-Pago, el proveedor de recargas— **no van en
`.dev.vars` ni en el repositorio**. Van con:

```bash
npx wrangler secret put NOMBRE_DEL_SECRETO --env staging
```

Quedan guardados dentro de Cloudflare, cifrados, y ni vos ni nadie los vuelve a
leer. Es otra cosa distinta del `CLOUDFLARE_API_TOKEN`: ése es la llave para
desplegar, éstos son las llaves que usa la aplicación cuando corre.
