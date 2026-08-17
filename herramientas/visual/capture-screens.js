/*
 * Fotografía todas las pantallas y las guarda para comparar.
 *
 * Por qué existe
 * --------------
 * La v4.7.0 borra CSS. Borrar CSS **rompe en silencio**: si una clase estaba
 * viva y la sacamos, la pantalla se ve mal y nada falla — no hay error, no hay
 * prueba roja, no hay registro. Se descubre cuando alguien lo mira.
 *
 * Así que acá se mira, pero no a ojo. Se fotografía todo antes, se borra, se
 * vuelve a fotografiar y se compara **pixel por pixel**. Lo que cambió de
 * tamaño, de color o de lugar aparece solo.
 *
 * Se fotografía en dos anchos porque el CSS que falta se nota distinto en cada
 * uno: en escritorio se ve un color raro, en móvil se ve una columna partida.
 *
 * Uso:
 *   node tools/capture-screens.js antes
 *   node tools/capture-screens.js despues
 *   node tools/capture-screens.js --comparar antes despues
 */
const fs = require('fs');
const path = require('path');
const { abrir: abrirNavegador } = require('./navegador.js');

const RAIZ = path.resolve(__dirname, '..');
const HTML = path.join(RAIZ, '.capturas/html');

const ANCHOS = [
    { nombre: 'escritorio', width: 1280, height: 900 },
    { nombre: 'movil', width: 390, height: 844 },
];

async function capturar(destino) {
    const salida = path.join(RAIZ, '.capturas', destino);
    fs.mkdirSync(salida, { recursive: true });

    /*
     * `--hide-scrollbars` es lo que de verdad saca la barra.
     *
     * Esconderla por CSS no alcanza: para cuando el estilo entra, el navegador
     * ya reservó su espacio, y la franja de tres pixeles del borde derecho
     * seguía cambiando de foto en foto. Con el navegador arrancado así, no
     * existe.
     */
    /*
     * La huella de estilos: lo que la foto NO ve.
     *
     * La comparación por foto tiene un agujero que costó descubrir: **sólo ve
     * lo que se ve**. Un elemento adentro de un acordeón cerrado, de una
     * pestaña interna o de un bloque `hidden` no sale en la imagen, así que se
     * le puede cambiar el color sin que nada lo note.
     *
     * Pasó de verdad en esta misma entrega: sacar un `!important` de las
     * tarjetas de forma de cobro las devolvió de gris a blanco —el defecto que
     * un arreglo anterior había resuelto a propósito— y las 134 fotos dieron
     * «ninguna pantalla cambió».
     *
     * Esto lee el color, el borde, el tipo de caja y el tamaño de letra que el
     * navegador CALCULÓ para cada elemento con clase `ryc-`, esté visible o no.
     */
    const huella = async (pagina) =>
        pagina.evaluate(() => {
            const salida = [];

            document.querySelectorAll('[class*="ryc-"]').forEach((nodo) => {
                const c = getComputedStyle(nodo);
                salida.push(
                    [
                        // Un <svg> tiene `className` como objeto, no como texto.
                        String(nodo.getAttribute('class') || '').trim(),
                        c.backgroundColor,
                        c.color,
                        c.borderTopColor,
                        c.display,
                        c.fontSize,
                        c.borderRadius,
                    ].join('|')
                );
            });

            return salida;
        });

    const navegador = await abrirNavegador({
        args: [
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            /*
             * Las dos banderas que hacen determinista la captura.
             *
             * Chromium reaprovecha mosaicos ya rasterizados cuando saca una foto
             * de pagina completa. Si un texto cae en medio pixel —y pasa: una
             * ficha de 60 px con 10 de relleno centra su bloque de 35 px en
             * `456.5`— el redondeo lo decide el rasterizador y no el layout, asi
             * que la misma pantalla sale un pixel mas arriba o mas abajo segun el
             * humor del momento.
             *
             * Medido: `panel-recharge--movil` fallaba 6 de 120 corridas, siempre
             * con los mismos 1.324 pixeles y la misma caja. A escala de arbol,
             * entre 17 y 27 pantallas distintas por par sin estas banderas.
             *
             * Con las dos puestas: TRES arboles completos seguidos, byte por
             * byte identicos. Hacen falta las dos — cada una sola baja el ruido
             * pero no lo elimina.
             *
             * Esto es la causa raiz del ruido que se venia tratando como
             * inevitable, y de la regla «se descarta la primera corrida de cada
             * arbol». Esa regla no tenia sustento: el ruido no era del arranque
             * en frio, estaba repartido entre corridas.
             */
            '--disable-partial-raster',
            '--disable-checker-imaging',
        ],
    });
    let total = 0;
    const estilos = {};

    for (const medida of ANCHOS) {
        const pagina = await navegador.newPage({ viewport: { width: medida.width, height: medida.height } });

        /*
         * Se congela todo lo que se mueve.
         *
         * Sin esto, dos fotos del MISMO archivo salían distintas: el panel tiene
         * animaciones —resplandores, pulsos, barras que crecen— y la foto las
         * agarra en una fase cualquiera. La comparación marcaba como «cambió»
         * una pantalla que nadie había tocado, que es la forma más rápida de
         * que una herramienta así deje de mirarse.
         *
         * `-1s` de retardo empuja cada animación a su estado final: no es que
         * no se vean, es que se ven siempre en el mismo momento.
         */
        for (const archivo of fs.readdirSync(HTML).sort()) {
            if (!archivo.endsWith('.html')) continue;

            await pagina.goto('file://' + path.join(HTML, archivo));
            await pagina.addStyleTag({
                content: `*, *::before, *::after {
                    animation-delay: -1s !important;
                    animation-duration: 0s !important;
                    animation-iteration-count: 1 !important;
                    transition-duration: 0s !important;
                    transition-delay: 0s !important;
                    caret-color: transparent !important;
                    /*
                     * Y NADIE ESTA EN HOVER.
                     *
                     * El puntero del navegador arranca en (0,0), así que
                     * cualquier pantalla que tenga algo pegado a la esquina de
                     * arriba a la izquierda lo dibuja a veces con el estilo de
                     * hover y a veces sin el. La pantalla componente-support-files tiene
                     * ahí el campo de archivo, que en hover cambia de borde: la
                     * misma pantalla, sin tocar una línea de CSS, salía
                     * distinta entre dos corridas.
                     *
                     * Eso es peor que un falso positivo suelto: una red que
                     * marca una pantalla que nadie tocó enseña a leer «cambió»
                     * como «ruido», y el día que cambie de verdad nadie va a
                     * mirar.
                     *
                     * pointer-events:none hace que el hover no pueda
                     * coincidir con nada. No mueve el diseño ni el pintado —
                     * sólo saca del medio un estado que una foto fija no tiene
                     * por qué capturar.
                     */
                    pointer-events: none !important;
                }
                /*
                 * La barra de desplazamiento se esconde.
                 *
                 * Es lo último que quedaba moviéndose: en las pantallas que
                 * desbordan a lo ancho, el navegador la dibuja de una franja de
                 * tres pixeles que cambia de foto en foto. Diez pantallas
                 * aparecían como «distintas» por eso, y todas las diferencias
                 * estaban en la misma columna del borde derecho.
                 */
                ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
                html { scrollbar-width: none !important; }`,
            });

            /*
             * Y SE MUEVE EL PUNTERO, que es la mitad que faltaba.
             *
             * `pointer-events:none` sola no alcanza: el navegador guarda a quien
             * esta en hover y no lo recalcula hasta que el mouse se mueve. Con
             * la regla puesta y sin mover nada, el estado que quedo de antes se
             * queda pegado, y el enlace «volver» de las pantallas de detalle
             * salia del color de hover en una corrida y del normal en la
             * siguiente. Se veia como «cambio el CSS» sin que nadie tocara CSS.
             *
             * Con todo en `pointer-events:none`, mover el puntero a cualquier
             * lado no encuentra a nadie: el hover queda en nada, siempre.
             */
            await pagina.mouse.move(medida.width - 1, medida.height - 1);

            /*
             * Lo pegajoso deja de pegarse, preguntandole al navegador cual lo es.
             *
             * En una foto de pagina completa, un elemento `position:sticky` se
             * dibuja donde estaria con la pagina sin desplazar: flotando en el
             * medio y TAPANDO lo que hay debajo. La barra de guardar de Mi
             * perfil ocultaba las etiquetas «Nombre visible» y «Apodo gamer»;
             * los botones de guardar del admin ocultaban campos en nueve
             * pantallas. Dos revisiones distintas lo reportaron como defecto, y
             * las dos tenian razon en lo que veian: la foto mentia.
             *
             * Se resuelve leyendo el estilo CALCULADO, no adivinando nombres de
             * clase: cualquier elemento que el navegador considere pegajoso
             * pasa a POSICIONADO SIN DESPLAZAR, incluidos los que aparezcan
             * manana.
             *
             * Y `relative`, no `static`. La diferencia costo una captura entera.
             * ------------------------------------------------------------------
             * Esto decia `static`, y `static` NO ES «lo mismo pero quieto»: un
             * elemento estatico ignora su `z-index`. La barra del canal del
             * vendedor declara `z-index:20` justamente para dibujarse por
             * encima del hero, que en la v4.26.0 le pasa por detras. Al pasarla
             * a `static`, el z-index se caia, el hero la tapaba entera y la
             * barra DESAPARECIA de la foto de pagina completa — mientras en el
             * navegador de verdad se veia perfecta.
             *
             * O sea: la herramienta que existe para que la foto no mienta
             * estaba fabricando la mentira. Y del peor tipo, la que borra un
             * componente sin decir nada.
             *
             * `relative` sin desplazamientos deja el elemento exactamente donde
             * lo pone el flujo —que es todo lo que se buscaba— y le conserva el
             * z-index. Los `auto` son necesarios: un `top:10px` heredado del
             * `sticky` desplazaria de verdad al elemento relativo.
             */
            await pagina.$$eval('*', (nodos) => {
                nodos.forEach((n) => {
                    if (getComputedStyle(n).position === 'sticky') {
                        n.style.position = 'relative';
                        n.style.top = 'auto';
                        n.style.right = 'auto';
                        n.style.bottom = 'auto';
                        n.style.left = 'auto';
                    }
                });
            });

            /*
             * Los desplegables se abren ANTES de fotografiar.
             *
             * El admin esconde acciones dentro de `<details>` cerrados: la
             * gestion de un retiro, con su formulario y su campo de archivo,
             * vive ahi adentro. Cerrado, la foto muestra un boton y nada mas, y
             * todo lo que hay debajo queda fuera de la red visual — el mismo
             * agujero que tenian las sub-secciones de Mi perfil.
             *
             * Se abren en TODAS las paginas, no solo en las del admin: un
             * desplegable cerrado nunca es lo que hay que verificar.
             */
            await pagina.$$eval('details', (nodos) => nodos.forEach((n) => { n.open = true; }));

            // La huella de estilos va SIEMPRE, aunque la foto no lo vea.
            estilos[archivo + '--' + medida.nombre] = await huella(pagina);

            /*
             * Los DOS paneles: el del vendedor y el del distribuidor. (v4.36.0)
             *
             * `panel-distribuidor.html` es el mismo documento dibujado con otro
             * perfil, y sus pestanas hay que activarlas igual: si se
             * fotografiara entero, todo lo que no es la pestana activa queda
             * colapsado en altura cero y ninguna herramienta lo mide. Asi
             * vivieron tres defectos que el usuario encontro a mano.
             */
            const esPanel = archivo === 'panel.html' || archivo === 'panel-distribuidor.html';
            const prefijo = archivo === 'panel.html' ? 'panel' : 'panel-distribuidor';

            if (!esPanel) {
                await pagina.screenshot({
                    path: path.join(salida, `${archivo.replace('.html', '')}--${medida.nombre}.png`),
                    fullPage: true,
                });
                total++;
                continue;
            }

            /*
             * El panel es UN documento con las doce pestañas adentro, igual que
             * en el navegador de verdad. Se activa una por vez, que es
             * exactamente lo que hace el script del panel.
             */
            const pestanas = await pagina.$$eval('[data-ryc-panel]', (nodos) =>
                nodos.map((n) => n.getAttribute('data-ryc-panel'))
            );

            for (const pestana of pestanas) {
                await pagina.$$eval(
                    '[data-ryc-panel]',
                    (nodos, activa) => {
                        nodos.forEach((n) => n.classList.toggle('is-active', n.getAttribute('data-ryc-panel') === activa));
                    },
                    pestana
                );

                await pagina.screenshot({
                    path: path.join(salida, `${prefijo}-${pestana}--${medida.nombre}.png`),
                    fullPage: true,
                });
                total++;

                /*
                 * Y un nivel más adentro: las sub-secciones de Mi perfil.
                 *
                 * Mi perfil no es una pantalla, son cuatro: Perfil público,
                 * Formas de cobro, Datos fiscales y Verificación. Sólo la
                 * primera sale en la foto de la pestaña; las otras tres nacen
                 * con `hidden` y nunca se fotografiaron.
                 *
                 * El agujero era grande: los cuatro campos de archivo de
                 * Verificación —los únicos OBLIGATORIOS del panel— vivían fuera
                 * de la red visual entera. Se podían romper y las 134 fotos
                 * seguían dando idénticas.
                 *
                 * Se buscan dentro de la pestaña activa a propósito: si algún
                 * día otra pestaña estrena sub-secciones, entran solas.
                 */
                const secciones = await pagina.$$eval(
                    '[data-ryc-panel].is-active [data-ryc-profile-section]',
                    (nodos) => nodos.map((n) => n.getAttribute('data-ryc-profile-section'))
                );

                for (const seccion of secciones) {
                    await pagina.$$eval(
                        '[data-ryc-panel].is-active [data-ryc-profile-section]',
                        (nodos, activa) => {
                            nodos.forEach((n) => {
                                const suya = n.getAttribute('data-ryc-profile-section') === activa;
                                n.classList.toggle('is-active', suya);
                                n.hidden = !suya;
                            });
                        },
                        seccion
                    );

                    await pagina.screenshot({
                        path: path.join(salida, `${prefijo}-${pestana}-${seccion}--${medida.nombre}.png`),
                        fullPage: true,
                    });
                    total++;
                }
            }
        }

        await pagina.close();
    }

    await navegador.close();

    fs.writeFileSync(path.join(salida, 'estilos.json'), JSON.stringify(estilos, null, 1));

    console.log(`Capturas: ${total} en .capturas/${destino}`);
    console.log(`Huella de estilos: ${Object.keys(estilos).length} pantallas`);
}

/**
 * Compara dos carpetas contando PIXELES, no bytes.
 *
 * Por qué no bytes
 * ----------------
 * La primera versión comparaba los bytes del PNG. Parecía lo más estricto y era
 * lo más inútil: dos fotos de la MISMA pantalla, sin tocar una línea, salían
 * distintas. Dos causas, las dos reales y las dos ajenas al CSS:
 *
 * · las animaciones del panel, que la foto agarra en una fase cualquiera
 *   —arreglado congelándolas—;
 * · las barras de desplazamiento de los contenedores que desbordan, una franja
 *   de tres pixeles en el borde que el navegador dibuja distinto según el
 *   momento.
 *
 * Con veintitrés pantallas marcadas como «cambió» sin que nadie las tocara, la
 * herramienta no sirve: lo que se aprende es a ignorarla.
 *
 * La regla
 * --------
 * Se cuentan los pixeles distintos y dónde están. Pasa si son menos del 0,05%
 * y además caben en una franja de ocho pixeles de ancho —o sea, si es el borde—.
 * Cualquier otra cosa es un cambio de verdad y hay que mirarlo.
 *
 * El conteo va en el navegador, con un canvas: no hace falta ninguna biblioteca
 * de imágenes que instalar.
 */
async function comparar(a, b) {
    const carpetaA = path.join(RAIZ, '.capturas', a);
    const carpetaB = path.join(RAIZ, '.capturas', b);

    const archivosA = fs.readdirSync(carpetaA).filter((f) => f.endsWith('.png')).sort();
    const archivosB = new Set(fs.readdirSync(carpetaB).filter((f) => f.endsWith('.png')));

    const navegador = await abrirNavegador();
    const pagina = await navegador.newPage();

    const distintas = [];
    const faltantes = [];
    const borde = [];
    let iguales = 0;

    for (const nombre of archivosA) {
        if (!archivosB.has(nombre)) {
            faltantes.push(nombre);
            continue;
        }

        const uno = fs.readFileSync(path.join(carpetaA, nombre)).toString('base64');
        const dos = fs.readFileSync(path.join(carpetaB, nombre)).toString('base64');

        const r = await pagina.evaluate(async ([u, d]) => {
            const cargar = (b64) =>
                new Promise((res, rej) => {
                    const img = new Image();
                    img.onload = () => res(img);
                    img.onerror = rej;
                    img.src = 'data:image/png;base64,' + b64;
                });

            const [a1, a2] = await Promise.all([cargar(u), cargar(d)]);

            if (a1.width !== a2.width || a1.height !== a2.height) {
                return { alto: true, antes: [a1.width, a1.height], despues: [a2.width, a2.height] };
            }

            const lienzo = (img) => {
                const c = document.createElement('canvas');
                c.width = img.width;
                c.height = img.height;
                c.getContext('2d').drawImage(img, 0, 0);
                return c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
            };

            const p1 = lienzo(a1);
            const p2 = lienzo(a2);

            let n = 0;
            let x0 = Infinity;
            let x1 = -1;
            let y0 = Infinity;
            let y1 = -1;

            for (let i = 0; i < p1.length; i += 4) {
                if (p1[i] === p2[i] && p1[i + 1] === p2[i + 1] && p1[i + 2] === p2[i + 2]) continue;
                n++;
                const px = (i / 4) % a1.width;
                const py = Math.floor(i / 4 / a1.width);
                if (px < x0) x0 = px;
                if (px > x1) x1 = px;
                if (py < y0) y0 = py;
                if (py > y1) y1 = py;
            }

            return { alto: false, n, total: a1.width * a1.height, x0, x1, y0, y1, ancho: a1.width };
        }, [uno, dos]);

        if (r.alto) {
            distintas.push({ nombre, texto: `cambió de tamaño: ${r.antes.join('x')} → ${r.despues.join('x')}` });
            continue;
        }

        if (r.n === 0) {
            iguales++;
            continue;
        }

        const proporcion = r.n / r.total;
        const anchoFranja = r.x1 - r.x0 + 1;

        /*
         * Ruido de borde: poquísimos pixeles y todos pegados al margen derecho.
         *
         * Ahí viven las barras de desplazamiento de los contenedores que
         * desbordan —tablas anchas, sobre todo—, y el navegador las dibuja
         * distinto según el momento. No hay CSS nuestro que se vea así: un
         * cambio de verdad mueve o repinta una zona, no una tira de dos pixeles
         * contra el borde.
         */
        const pegadoAlBorde = r.x0 >= r.ancho - 40;

        if (proporcion < 0.0005 && (anchoFranja <= 8 || pegadoAlBorde)) {
            borde.push(nombre);
            continue;
        }

        distintas.push({
            nombre,
            texto: `${r.n} pixeles (${(proporcion * 100).toFixed(2)}%) en x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1}`,
        });
    }

    await navegador.close();

    /* La huella de estilos: lo que la foto no ve. */
    const rutaA = path.join(carpetaA, 'estilos.json');
    const rutaB = path.join(carpetaB, 'estilos.json');
    let estiloDistintas = 0;

    if (fs.existsSync(rutaA) && fs.existsSync(rutaB)) {
        const eA = JSON.parse(fs.readFileSync(rutaA, 'utf8'));
        const eB = JSON.parse(fs.readFileSync(rutaB, 'utf8'));

        for (const clave of Object.keys(eA)) {
            if (!eB[clave]) continue;

            const uno = eA[clave];
            const dos = eB[clave];
            const cambios = [];

            if (uno.length !== dos.length) {
                cambios.push(`cantidad de elementos: ${uno.length} → ${dos.length}`);
            } else {
                for (let i = 0; i < uno.length; i++) {
                    if (uno[i] !== dos[i]) cambios.push(`${uno[i]}\n           →  ${dos[i]}`);
                    if (cambios.length >= 3) break;
                }
            }

            if (cambios.length) {
                estiloDistintas++;
                console.log(`  ✗ ESTILO ${clave}`);
                cambios.forEach((c) => console.log(`      ${c}`));
            }
        }
    }

    console.log(`Idénticas:          ${iguales}`);
    console.log(`Sólo el borde:      ${borde.length}   (barras de desplazamiento, no es CSS)`);
    console.log(`CAMBIARON:          ${distintas.length}`);

    if (faltantes.length) console.log(`Desaparecieron: ${faltantes.join(', ')}`);

    for (const d of distintas) {
        console.log(`  ✗ ${d.nombre}\n      ${d.texto}`);
    }

    if (!distintas.length && !faltantes.length) {
        console.log('\nNinguna pantalla cambió.');
    }

    console.log(`Estilos cambiados:  ${estiloDistintas}   (incluye lo que la foto no ve)`);

    process.exitCode = distintas.length || faltantes.length || estiloDistintas ? 1 : 0;
}

const args = process.argv.slice(2);

if (args[0] === '--comparar') {
    comparar(args[1], args[2]);
} else {
    capturar(args[0] || 'antes');
}
