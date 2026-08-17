# Contrato visual

Las 69 pantallas del panel del plugin, congeladas. **Esto no es documentación:
es el contrato.** Cada pantalla portada al Worker se compara contra su captura
de acá, y el resultado es diff cero o una diferencia decidida a propósito con el
motivo escrito. No hay tercera opción.

## Qué hay adentro

```
referencia/     138 capturas · 69 pantallas × escritorio y móvil
MANIFIESTO.txt  el md5 de cada una
```

Las 69 son: **32 del panel** (18 vendedor digital + 14 distribuidor), **24
públicas** (catálogo, canal, verificación, comprobante, acceso) y **13
componentes** reutilizados.

**Las 36 pantallas del admin quedaron afuera a propósito.** El backoffice se
rehace completo, así que no hay nada que conservar.

## De dónde salieron

Del árbol `recargayacoreESTADOCOMPLETO_v4.78.0` del plugin de WordPress, que se
congela como implementación de referencia:

```
php tools/render-screens.php      → 77 documentos HTML con dobles de WordPress
node tools/capture-screens.js X   → 210 capturas en dos anchos
```

No hace falta un sitio corriendo. El arnés renderiza las plantillas de verdad
con un WordPress de mentira y escribe HTML a disco; el navegador lo abre con
`file://`.

## Por qué son reproducibles

Chromium reaprovecha mosaicos ya rasterizados al fotografiar una página
completa. Cuando un texto cae en medio píxel —y pasa: una ficha de categoría de
60 px con 10 de relleno centra su bloque de 35 px en `456,5`— el redondeo lo
decide el rasterizador y no el layout, y la misma pantalla sale un píxel más
arriba o más abajo según el momento.

Medido: `panel-recharge--movil` fallaba **6 de 120 corridas**, siempre con los
mismos 1.324 píxeles. A escala de árbol, entre 17 y 27 pantallas distintas por
par.

Se cierra con dos banderas, y **hacen falta las dos**:

```js
'--disable-partial-raster', '--disable-checker-imaging'
```

Con ellas puestas: tres árboles completos seguidos, **idénticos byte por byte**,
uno de ellos sacado con 70 segundos de hueco de reloj.

Están en `herramientas/visual/capture-screens.js`, con el porqué escrito al lado.

## Cómo se compara

```
node herramientas/visual/capture-screens.js --comparar referencia <nuevo>
```

El veredicto útil es `CAMBIARON: 0`. Cualquier otra cosa es una regresión o una
mejora deliberada — y si es lo segundo, se escribe el motivo.

Para comprobar que la referencia no se corrompió, alcanza el manifiesto:

```
md5sum -c MANIFIESTO.txt
```

## Dos advertencias que ahorran tiempo

**No hay capturas «ruidosas».** Documentos anteriores del proyecto nombraban
`componente-bell-panel--escritorio` y `admin-dock-states--movil` como
inestables, y recomendaban estabilizarlas o excluirlas del diff. Con las dos
banderas puestas no hay ninguna: 210 de 210 idénticas. Excluirlas habría sido
tapar el síntoma.

**No hace falta descartar la primera corrida.** Esa regla describía un ruido
cuya causa nadie había buscado. Medido: las anomalías caían en las iteraciones
2, 18, 22, 23 y 39 — repartidas, no en el arranque en frío.

## Dos defectos conocidos, los dos fuera del contrato

**`admin-reports` se pudre sola cada día calendario.**
`modules/Reports/class-ryc-reports.php:129` hace
`wp_date('Y-m-d', strtotime('-' . $i . ' days'))`: el segundo argumento sale del
reloj real y no del congelado, así que el eje del gráfico cambia de día. El
patrón correcto ya existe en el plugin —
`modules/Statements/class-ryc-statement.php:281` documenta explícitamente «NO SE
HACE CON `strtotime()`» y usa `current_datetime()`— pero `Reports` y
`Profitability` quedaron sin convertir.

**`wp_validate_redirect()` del arnés es más permisivo que WordPress.** Mira sólo
el host, así que pasan `javascript://recargaya.example/%0aalert(1)` y
`vbscript://...`. WordPress restringe a `http`/`https` y sanea la cadena antes de
parsear. Es la función donde vive la ley 8.
