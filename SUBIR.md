# Cómo subir esto al repositorio

Una sola vez, desde tu computadora. Después, todo va por pull request.

## Si tenés git en tu máquina

Descomprimí el archivo, entrá a la carpeta y corré:

```bash
bash subir.sh
```

El script hace la rama, el commit y el push. Después te da el enlace para abrir
el pull request en GitHub.

## Si preferís no tocar la terminal

GitHub te deja subir archivos desde el navegador, pero **no carpetas enteras**,
así que para este primer commit conviene el script.

Si igual querés hacerlo a mano: en
`github.com/recargayapy/recargaya-platform` → botón **Add file** → **Upload
files**, y arrastrás los archivos respetando las carpetas. Es tedioso y fácil
de equivocar; el script es cinco segundos.

## Qué va a pasar después

En cuanto exista la rama, GitHub Actions corre solo:

1. **Tipos** — TypeScript estricto
2. **Pruebas** — las 36
3. **Mutación** — rompe 18 invariantes y exige que las pruebas mueran
4. **Ningún secreto versionado**

Si los cuatro pasan, el pull request queda en verde y lo podés revisar.

El despliegue a staging **no va a correr todavía**: espera a que cargues los
dos secretos de Cloudflare y crees las bases de D1. Eso está paso a paso en
`docs/PRIMER-DESPLIEGUE.md`.
