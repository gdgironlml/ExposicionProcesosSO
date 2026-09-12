
// ============================================================================
// 1. VARIABLES GLOBALES
// ============================================================================
let procesos = {};
let interrupciones = {};
let pidsConFlash = new Set();
let simulacionPausada = false;

// Constantes de tiempo
const FASE_BUSQUEDA_MS = 2000;                 // ← Fase de BÚSQUEDA (fetch): 1 segundo
const FASE_EJECUCION_MS = 4000;                // ← Fase de EJECUCIÓN: 4 segundos
const QUANTUM_MS = FASE_BUSQUEDA_MS + FASE_EJECUCION_MS; // 5 segundos por quantum
const TIEMPO_TICK_MS = 100;                    // Reloj del SO (fino, para fases exactas)
const TIEMPO_ATENCION_INTERRUPCION_MS = 2500;  // Tiempo de atención de E/S
const VIDA_TERMINADO_MS = 3000;                // Tiempo antes de borrar SALIENTE
const TIEMPO_ADMISION_MS = 3000;               // ← NUEVO tarda 3s en pasar a LISTO
const PROB_SOLICITUD_ES = 0.4;      // 40% de probabilidad de que el proceso pida E/S durante esta ejecución
const TIEMPO_ESPERA_ES_MS = 5000;    // Cuánto dura la espera de E/S antes de volver a LISTO

// Estado de la CPU
const cpu = {
    pid: null,                    // PID del proceso en ejecución
    fase: null,                   // 'busqueda' | 'ejecucion'
    faseInicio: null,             // Timestamp inicio de la fase actual
    faseFin: null,                // Timestamp fin de la fase actual
    atendiendoInterrupcion: false,
    finAtencion: null,
    inicioAtencion: null,
    nivelAtendido: null,
    interruptId: null,
    pidBloqueado: null,           // PID que se bloqueó por E/S
    pausadoDesde: null,           // Timestamp en que se pausó (para reanudar sin perder progreso)

    // --- Simulación "en vivo" durante la fase de EJECUCIÓN ---
    // Estos valores se recalculan en cada tick MIENTRAS el proceso ejecuta,
    // para que se vea que el IR y los registros van cambiando de verdad.
    // Cuando termina el quantum (o llega una interrupción), el ÚLTIMO valor
    // generado aquí es el que se guarda en el BCP (tabla de abajo).
    pcEnVivo: null,
    irEnVivo: null,
    registrosEnVivo: null,

    momentoBloqueo: null,
};

// ============================================================================
// CONTROL DE RECEPCIÓN (Admisión de nuevos procesos / interrupciones)
// ============================================================================
// Bandera compartida en Firebase: cuando está en true, el cliente (teléfono)
// debe bloquear el envío de nuevos procesos e interrupciones. El host solo
// pone/quita la bandera; la validación real de "no dejar enviar" ocurre en
// el script del cliente (teléfono), que debe leer esta misma ruta.
let recepcionCerrada = false;
let refConfig;
if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
    refConfig = firebase.database().ref('config');
}

// ============================================================================
// 2. FUNCIONES AUXILIARES
// ============================================================================
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    // String(str) asegura que si llega un número, se convierta a texto sin dar error
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}


/**
 * PC inicial de un proceso nuevo: cada proceso arranca en una dirección de
 * memoria distinta (simulando que el SO lo cargó en una zona distinta de
 * memoria), en vez de que todos empiecen siempre en 0x1000.
 */
function pcInicialAleatorio() {
    // Empieza en una "línea de código" inicial aleatoria (ej. entre 10 y 90)
    return Math.floor(Math.random() * 80) + 10;
}
/**
 * Calcula el PC de la SIGUIENTE instrucción al terminar la ejecución.
 * En vez de avanzar siempre +4 (lo que hacía que todos los procesos
 * siguieran exactamente el mismo patrón de direcciones), se salta a una
 * nueva dirección aleatoria — como si cada instrucción pudiera ser una
 * instrucción secuencial, un salto (JMP) o una llamada (CALL) a otra zona
 * del programa. Este es el valor que se guarda en el BCP al terminar la
 * ejecución.
 */
function avanzarPC(pcActual) {
    // En un CPU real, el PC simplemente avanza a la siguiente instrucción (+1)
    let actual = parseInt(pcActual, 10);
    if (isNaN(actual)) actual = 10;
    return actual + 1;
}

/**
 * Genera registros aleatorios nuevos.
 * Representa que el proceso ha modificado su estado de contexto durante la ejecución.
 * En un cambio de contexto, estos se guardan en el BCP.
 *
 * Se usan valores de solo 2 dígitos hex (0x00–0xFF) en lugar de 4 (0x0000–0xFFFF):
 * son más cortos y fáciles de leer/comparar de un vistazo cuando cambian entre
 * BCPs, sin perder el formato hexadecimal típico de un registro.
 */
/**
 * Genera registros con números enteros simples (0-99).
 * Ideal para visualización rápida en exposiciones.
 */
function registrosAleatorios() {
    // Genera un número entero aleatorio del 0 al 99
    const entero = () => Math.floor(Math.random() * 100);
    return { AX: entero(), BX: entero(), CX: entero(), DX: entero() };
}

/**
 * Simula la instrucción "capturada" en el Registro de Instrucción (IR).
 * El IR contiene el CÓDIGO DE OPERACIÓN (opcode) en hexadecimal de la instrucción
 * ACTUAL que el procesador está ejecutando (p. ej. "5601"), a diferencia del PC,
 * que apunta a la dirección de memoria de la SIGUIENTE instrucción.
 */
function instruccionAleatoria() {
    // Un número de instrucción simple de 3 dígitos (ej. 405, 812)
    return Math.floor(Math.random() * 900) + 100;
}

function formatoHora() {
    const ahora = new Date();
    return ahora.toLocaleTimeString('es-ES', { 
        hour: '2-digit', minute: '2-digit', second: '2-digit' 
    });
}

// ============================================================================
// 3. ACTUALIZACIÓN VISUAL DEL NÚCLEO
// ============================================================================
// Tiempo "efectivo" — si está pausado, se congela en el instante de la pausa
// para que ninguna animación (progreso, fases) siga avanzando mientras está en pausa.
function ahoraEfectivo() {
    return simulacionPausada && cpu.pausadoDesde ? cpu.pausadoDesde : Date.now();
}

function actualizarNucleo() {
    const nucleo = document.getElementById('core-ring');
    const coreInner = document.getElementById('core-inner');
    const metaQuantum = document.getElementById('meta-quantum');
    const metaRestantes = document.getElementById('meta-restantes');
    const progressFg = document.getElementById('progress-fg');

    if (!nucleo || !coreInner) return;

    // Estados visuales
    nucleo.classList.remove('is-running', 'is-interrupt', 'is-paused', 'fase-busqueda', 'fase-ejecucion');
    if (simulacionPausada) {
        nucleo.classList.add('is-paused');
    } else if (cpu.atendiendoInterrupcion) {
        nucleo.classList.add('is-interrupt');
    } else if (cpu.pid) {
        nucleo.classList.add('is-running');
        if (cpu.fase === 'busqueda') nucleo.classList.add('fase-busqueda');
        if (cpu.fase === 'ejecucion') nucleo.classList.add('fase-ejecucion');
    }

    // Contenido del núcleo
    if (cpu.pid && !cpu.atendiendoInterrupcion) {
        const p = procesos[cpu.pid];
        if (p) {
            // CORRECCIÓN: El texto ahora depende dinámicamente de los ms que le pongas en el código
            const faseTexto = cpu.fase === 'busqueda' ? `BÚSQUEDA (${FASE_BUSQUEDA_MS/1000}s)` : `EJECUCIÓN (${FASE_EJECUCION_MS/1000}s)`;
            const faseColor = cpu.fase === 'busqueda' ? 'var(--amber)' : 'var(--cyan)';
            coreInner.innerHTML = `
                <div class="pid">${p.pid}</div>
                <div class="name">${escapeHTML(p.nombre)}</div>
                <div class="fase-label" style="color:${faseColor}">${faseTexto}</div>
            `;

            // Barra de progreso de la FASE actual (0% a 100%), tiempo congelado si hay pausa
            if (cpu.faseInicio && cpu.faseFin) {
                const ahora = ahoraEfectivo();
                const duracion = cpu.faseFin - cpu.faseInicio;
                const transcurrido = Math.min(Math.max(ahora - cpu.faseInicio, 0), duracion);
                const porcentaje = (transcurrido / duracion) * 100;
                const dashOffset = 414.7 * (1 - porcentaje / 100);

                if (progressFg) {
                    progressFg.setAttribute('stroke-dashoffset', dashOffset);
                    progressFg.setAttribute('stroke', faseColor);
                }

                // CORRECCIÓN: Se oculta/comenta la actualización del texto "Fase: 4.0sQ:"
                // if (metaQuantum) metaQuantum.textContent = (duracion / 1000).toFixed(1) + 's';
                // if (metaRestantes) metaRestantes.textContent = p.quantumsRestantes + '/' + p.quantumsTotales;
            }

            renderBCPEnVivo(p);
            return;
        }
    } else if (cpu.atendiendoInterrupcion) {
        const nivelNombre = { 1: 'Baja', 2: 'Media', 3: 'Alta' };
        coreInner.innerHTML = `
            <div class="pid" style="color:var(--red);">E/S</div>
            <div class="name">Interrupción Nivel ${cpu.nivelAtendido} (${nivelNombre[cpu.nivelAtendido] || ''})</div>
            <div class="fase-label" style="color:var(--red);">ATENDIENDO (${(TIEMPO_ATENCION_INTERRUPCION_MS/1000).toFixed(1)}s)</div>
        `;
        if (cpu.inicioAtencion && cpu.finAtencion) {
            const ahora = ahoraEfectivo();
            const duracion = cpu.finAtencion - cpu.inicioAtencion;
            const transcurrido = Math.min(Math.max(ahora - cpu.inicioAtencion, 0), duracion);
            const porcentaje = (transcurrido / duracion) * 100;
            const dashOffset = 414.7 * (1 - porcentaje / 100);
            if (progressFg) {
                progressFg.setAttribute('stroke-dashoffset', dashOffset);
                progressFg.setAttribute('stroke', 'var(--red)');
            }
            if (metaQuantum) metaQuantum.textContent = 'E/S';
            if (metaRestantes) metaRestantes.textContent = Math.ceil((duracion - transcurrido) / 1000) + 's';
        }
    } else if (simulacionPausada) {
        coreInner.innerHTML = `<div class="idle">⏸<br>PAUSA</div>`;
        if (progressFg) progressFg.setAttribute('stroke-dashoffset', '414.7');
    } else {
        coreInner.innerHTML = `<div class="idle">CPU<br>IDLE</div>`;
        if (progressFg) progressFg.setAttribute('stroke-dashoffset', '414.7');
    }

    renderBCPEnVivo(null);
}

/**
 * Panel "BCP en vivo" — muestra el BCP del proceso que está ACTUALMENTE en la CPU,
 * a la par del núcleo. Este panel se actualiza en tiempo real (cada tick), pero
 * la tabla de BCP de abajo SOLO se actualiza cuando ocurre un cambio de contexto
 * real (asignación, fin de quantum, interrupción). Así se ve la diferencia entre
 * "lo que la CPU tiene cargado ahora" y "lo que quedó guardado la última vez".
 */
function renderBCPEnVivo(p) {
    const box = document.getElementById('bcp-vivo');
    if (!box) return;

    if (!p) {
        box.innerHTML = `<div class="bcp-vivo-empty">Sin proceso cargado en la CPU.</div>`;
        return;
    }

    const enBusqueda = cpu.fase === 'busqueda';
    let pcMostrado = cpu.pcEnVivo || p.pc || '10';
    if (pcMostrado === '0x1000') pcMostrado = '10';

    // Función rápida para limpiar los 0x0000 iniciales
    const cln = v => (v === '0x0000' || v === '0x00' || String(v).startsWith('0x')) ? 0 : v;
    
    let irMostrado = cpu.irEnVivo || '—';
    const regs = cpu.registrosEnVivo;
    let regsTexto = regs ? `AX:${cln(regs.AX)} BX:${cln(regs.BX)} CX:${cln(regs.CX)} DX:${cln(regs.DX)}` : '—';

    // --- NUEVO: CONDICIONAL DE BÚSQUEDA ---
    // Si la CPU está buscando, sobreescribimos visualmente el IR y los Registros
    if (enBusqueda) {
        irMostrado = 'buscando...';
        regsTexto = 'restaurando contexto...';
    }

    const estadoFase = enBusqueda ? 'EJECUTANDO · buscando instrucción' : 'EJECUTANDO';

    box.innerHTML = `
        <div class="bcp-vivo-row"><span>PID</span><b>P${p.pid}</b></div>
        <div class="bcp-vivo-row"><span>Nombre</span><b>${escapeHTML(p.nombre)}</b></div>
        <div class="bcp-vivo-row"><span>Estado</span><b>${estadoFase}</b></div>
        <div class="bcp-vivo-row"><span>PC</span><b><code>${pcMostrado}</code></b></div>
        <div class="bcp-vivo-row"><span>IR</span><b style="${enBusqueda ? 'color: var(--amber); font-style: italic;' : ''}"><code>${escapeHTML(irMostrado)}</code></b></div>
        <div class="bcp-vivo-row"><span>Registros</span><b style="${enBusqueda ? 'color: var(--amber); font-style: italic;' : ''}"><code style="font-size:0.85em;">${escapeHTML(regsTexto)}</code></b></div>
    `;
}

function pulsarNucleo(tipo) {
    const nucleo = document.getElementById('core-ring');
    if (!nucleo) return;
    
    nucleo.classList.remove('pulse-running', 'pulse-interrupt', 'pulse-switch', 'pulse-terminate');
    void nucleo.offsetWidth;
    
    if (tipo === 'running') nucleo.classList.add('pulse-running');
    else if (tipo === 'interrupt') nucleo.classList.add('pulse-interrupt');
    else if (tipo === 'switch') nucleo.classList.add('pulse-switch');
    else if (tipo === 'terminate') nucleo.classList.add('pulse-terminate');
}

setInterval(actualizarNucleo, 100);

// ============================================================================
// 4. GENERACIÓN DEL QR
// ============================================================================
function generarQR() {
    const qrContainer = document.getElementById('qr-canvas');
    if (!qrContainer) return;

    qrContainer.innerHTML = '';
    const urlActual = window.location.href;

    try {
        new QRCode(qrContainer, {
            text: urlActual,
            width: 350,
            height: 350,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    } catch (error) {
        console.error('Error al generar QR:', error);
        qrContainer.innerHTML = '<div style="color: red; font-size: 12px;">Error QR</div>';
    }
}

document.addEventListener('DOMContentLoaded', generarQR);
window.addEventListener('hashchange', generarQR);

// ============================================================================
// 5. LISTENERS DE FIREBASE
// ============================================================================
if (typeof refProcesos !== 'undefined') {
    refProcesos.on('value', snapshot => {
        procesos = snapshot.val() || {};
        renderBCP();
        renderColas();
    });
}

if (typeof refInterrupciones !== 'undefined') {
    refInterrupciones.on('value', snapshot => {
        interrupciones = snapshot.val() || {};
        renderColas();
    });
}

if (refConfig) {
    refConfig.child('recepcionCerrada').on('value', snapshot => {
        recepcionCerrada = snapshot.val() === true;
        actualizarBotonRecepcion();
    });
}

if (typeof refEventos !== 'undefined') {
    refEventos.on('child_added', snapshot => {
        const evento = snapshot.val();
        renderEvento(evento);
        
        if (evento.pid) {
            pidsConFlash.add(String(evento.pid));
            renderBCP();
            setTimeout(() => {
                pidsConFlash.delete(String(evento.pid));
                renderBCP();
            }, 1100);
        }
    });
}

// ============================================================================
// 6. RENDERIZADO DE COLAS
// ============================================================================
function renderColas() {
    // Cola de Listos
    const readyQueue = document.getElementById('ready-queue');
    if (readyQueue) {
        const listos = Object.values(procesos)
            .filter(p => p.estado === 'LISTO')
            .sort((a, b) => {
                // 1. Primero ordenamos por prioridad (1 = Alta, 2 = Media, 3 = Baja)
                const prioA = a.prioridad || 2;
                const prioB = b.prioridad || 2;
                if (prioA !== prioB) return prioA - prioB;
                
                // 2. Si tienen la misma prioridad, ordenamos por llegada (ordenListos)
                return (a.ordenListos || 0) - (b.ordenListos || 0);
            });

        if (listos.length === 0) {
            readyQueue.innerHTML = '<div class="queue-empty">Sin procesos en espera.</div>';
        } else {
            if (readyQueue.querySelector('.queue-empty')) readyQueue.innerHTML = '';
            const idsVistos = new Set();

            listos.forEach((p, idx) => {
                const chipId = 'ready-chip-' + p.pid;
                idsVistos.add(chipId);

                let chip = document.getElementById(chipId);
                if (!chip) {
                    chip = document.createElement('div');
                    chip.id = chipId;
                    chip.className = 'chip chip-anim';
                    chip.innerHTML = `
                        <div class="chip-left">
                            <span class="order-index"></span>
                            <span>
                                <strong class="chip-pid"></strong> 
                                <span class="chip-nombre"></span> 
                                <!-- NUEVO: Contenedor para el ícono de prioridad -->
                                <span class="chip-prio" style="font-size: 0.9em; margin-left: 4px;"></span>
                            </span>
                        </div>
                        <span class="q-left"></span>
                    `;
                } else {
                    chip.classList.remove('chip-anim');
                }

                // Determinamos el ícono según la prioridad
                const nivelPrio = p.prioridad || 2;
                let prioIcon = nivelPrio === 1 ? '🔴' : (nivelPrio === 2 ? '🟡' : '🟢');

                chip.querySelector('.order-index').textContent = idx + 1;
                chip.querySelector('.chip-pid').textContent = 'P' + p.pid;
                chip.querySelector('.chip-nombre').textContent = p.nombre;
                chip.querySelector('.chip-prio').textContent = prioIcon; // Inyectamos el color
                chip.querySelector('.q-left').textContent = p.quantumsRestantes + 'Q';

                const nodoEnEsaPos = readyQueue.children[idx];
                if (nodoEnEsaPos !== chip) readyQueue.insertBefore(chip, nodoEnEsaPos || null);
            });

            Array.from(readyQueue.children).forEach(el => {
                if (el.id && !idsVistos.has(el.id)) el.remove();
            });
        }
    }

    // Cola de Interrupciones — ordenada por PRIORIDAD (nivel), no por llegada
    const interruptQueue = document.getElementById('interrupt-queue');
    if (interruptQueue) {
        const intsPendientes = obtenerInterrupcionesOrdenadas();

        if (intsPendientes.length === 0) {
            interruptQueue.innerHTML = '<div class="queue-empty">Sin interrupciones pendientes.</div>';
        } else {
            if (interruptQueue.querySelector('.queue-empty')) interruptQueue.innerHTML = '';
            // Si la CPU está ocupada ejecutando, estas interrupciones deben ESPERAR
            // (atomicidad de la fase de ejecución) — se marca para que sea evidente.
            const esperandoCPU = !!cpu.pid && !cpu.atendiendoInterrupcion;
            const nivelNombre = { 1: 'Baja (Teclado/Ratón/Clic)', 2: 'Media (Disco/Red)', 3: 'Alta (Hardware)' };
            const idsVistos = new Set();

            intsPendientes.forEach((int, idx) => {
                const chipId = 'int-chip-' + int.id;
                idsVistos.add(chipId);

                let chip = document.getElementById(chipId);
                if (!chip) {
                    chip = document.createElement('div');
                    chip.id = chipId;
                    chip.className = 'chip int-chip chip-anim';
                    chip.innerHTML = `
                        <div class="chip-left">
                            <span class="order-index"></span>
                            <div class="tipo"></div>
                        </div>
                        <span class="espera-tag">⏳ en espera</span>
                    `;
                }

                chip.className = `chip int-chip chip-anim nivel-${int.nivel} ${esperandoCPU ? 'esperando' : ''}`;
                chip.querySelector('.order-index').textContent = idx + 1;
                chip.querySelector('.tipo').textContent = nivelNombre[int.nivel] || 'Desconocida';
                chip.querySelector('.espera-tag').style.display = esperandoCPU ? '' : 'none';

                const nodoEnEsaPos = interruptQueue.children[idx];
                if (nodoEnEsaPos !== chip) interruptQueue.insertBefore(chip, nodoEnEsaPos || null);
            });

            Array.from(interruptQueue.children).forEach(el => {
                if (el.id && !idsVistos.has(el.id)) el.remove();
            });
        }
    }
}

// ============================================================================
// 7. RENDERIZADO DE TIMELINE
// ============================================================================
function renderEvento(evento) {
    const timeline = document.getElementById('timeline');
    if (!timeline) return;
    
    const div = document.createElement('div');
    div.className = 'evento-card';
    
    if (evento.tipo === 'create') div.className += ' t-create';
    else if (evento.tipo === 'switch') div.className += ' t-switch';
    else if (evento.tipo === 'terminate') div.className += ' t-terminate';
    else if (evento.tipo === 'interrupt') {
        div.className += ' t-interrupt';
        if (evento.nivel) div.className += ` nivel-${evento.nivel}`;
    } else div.className += ' t-info';

    let icono = '⚡';
    if (evento.tipo === 'create') icono = '🟢';
    if (evento.tipo === 'switch') icono = '🔄';
    if (evento.tipo === 'interrupt') icono = evento.nivel === 3 ? '🛑' : evento.nivel === 2 ? '💾' : '⌨️';
    if (evento.tipo === 'terminate') icono = '✅';

    const estadoTransicion = evento.estadoAnterior && evento.estadoNuevo 
        ? `<div class="evento-transicion">
             <span>${evento.estadoAnterior}</span>
             <span class="flecha">→</span>
             <span>${evento.estadoNuevo}</span>
           </div>`
        : '';

    // Información adicional del cambio de contexto
    const contextoInfo = evento.pcAnterior && evento.pcNuevo
        ? `<div style="font-size:11px; color:var(--text-dim); margin-top:4px;">
             PC: ${evento.pcAnterior} → ${evento.pcNuevo}
           </div>`
        : '';

    div.innerHTML = `
        <div class="evento-head">
            <span class="evento-icono">${icono}</span>
            <span class="evento-etiqueta">${escapeHTML(evento.mensaje)}</span>
            <span class="evento-hora">${evento.fechaStr || formatoHora()}</span>
        </div>
        <div class="evento-mensaje">
            P${evento.pid || '—'} · ${evento.nombre ? escapeHTML(evento.nombre) : 'Sistema'}
            ${evento.pc ? ` · PC: ${evento.pc}` : ''}
            ${evento.quantumsRestantes !== undefined ? ` · Q: ${evento.quantumsRestantes}/${evento.quantumsTotales}` : ''}
        </div>
        ${estadoTransicion}
        ${contextoInfo}
    `;
    
    timeline.insertBefore(div, timeline.firstChild);
    
    while (timeline.children.length > 100) {
        timeline.removeChild(timeline.lastChild);
    }
}

// ============================================================================
// 8. LÓGICA DEL DISPATCHER - CAMBIO DE CONTEXTO SEGÚN STALLINGS
// ============================================================================

/**
 * ADMISIÓN (NUEVO -> LISTO)
 * El SO crea el BCP y el proceso entra en la Cola de Listos
 */
function procesarAdmisionNuevos() {
    const ahora = Date.now();
    Object.values(procesos).forEach(p => {
        if (p.estado === 'NUEVO') {
            const creadoEn = p.creadoEn || ahora;
            // El proceso permanece visiblemente en NUEVO durante TIEMPO_ADMISION_MS
            if (ahora - creadoEn < TIEMPO_ADMISION_MS) return;

            if (typeof refProcesos !== 'undefined') {
                refProcesos.child(p.pid).update({ estado: 'LISTO', ordenListos: Date.now() });
            }
            registrarEvento({
                tipo: 'switch',
                pid: p.pid, nombre: p.nombre,
                estadoAnterior: 'NUEVO', estadoNuevo: 'LISTO',
                mensaje: `Admisión: P${p.pid} (${p.nombre}) termina creación (3s) → Cola de Listos.`
            });
        }
    });
}

function obtenerColaListosOrdenada() {
    return Object.values(procesos)
        .filter(p => p.estado === 'LISTO')
        .sort((a, b) => {
            // 1. Primero por prioridad (1 = Alta, 2 = Media, 3 = Baja)
            const prioA = a.prioridad || 2;
            const prioB = b.prioridad || 2;
            if (prioA !== prioB) return prioA - prioB;
            
            // 2. Si tienen la misma prioridad, por orden de llegada (FIFO)
            return (a.ordenListos || 0) - (b.ordenListos || 0);
        });
}

/**
 * Cola de interrupciones ORDENADA POR PRIORIDAD (nivel 3 > 2 > 1).
 * Ante empate de nivel, gana la que llegó primero (FIFO dentro de la misma prioridad).
 */
function obtenerInterrupcionesOrdenadas() {
    return Object.keys(interrupciones).map(key => ({
        id: key,
        ...interrupciones[key]
    })).sort((a, b) => (b.nivel - a.nivel) || (a.timestamp - b.timestamp));
}

/**
 * DISPATCHER: CAMBIO DE CONTEXTO (LISTO -> EJECUTANDO)
 * 
 * Según Stallings Cap. 3, el Dispatcher:
 * 1. Selecciona un proceso de la Cola de Listos
 * 2. RESTAURA el contexto guardado (PC, registros) del BCP
 * 3. Cambia estado a EJECUTANDO
 * 4. Carga el PC en el contador de programa del procesador
 * 5. La CPU reanuda la ejecución desde donde se quedó
 */
function asignarCPU(pid) {
    const p = procesos[pid];
    if (!p) return;

    cpu.pid = pid;
    cpu.fase = 'busqueda';
    cpu.faseInicio = Date.now();
    cpu.faseFin = cpu.faseInicio + FASE_BUSQUEDA_MS;

    // *** RESTAURACIÓN DEL CONTEXTO ***
    // Usa p.pc (la instrucción guardada donde se quedó). Si el proceso es
    // nuevo (todavía no tiene PC), se le asigna una dirección inicial
    // aleatoria — así cada proceso arranca en una zona de memoria distinta
    // en vez de que todos empiecen siempre en 0x1000.
    const pcActual = (p.pc === '0x1000') ? pcInicialAleatorio() : (p.pc || pcInicialAleatorio());
    // Durante la fase de BÚSQUEDA la CPU solo sabe A DÓNDE va a buscar la
    // siguiente instrucción (el PC). El IR y los Registros todavía NO están
    // cargados en el procesador —siguen en el BCP— por eso se muestran en
    // blanco: se cargarán de una sola vez cuando termine la búsqueda.
    cpu.pcEnVivo = pcActual;
    cpu.irEnVivo = p.ir || instruccionAleatoria();
    cpu.registrosEnVivo = p.registros ? { ...p.registros } : registrosAleatorios();

    if (typeof refProcesos !== 'undefined') {
        refProcesos.child(pid).update({
            estado: 'EJECUTANDO',
            pc: pcActual,           // Mantiene el PC restaurado en la BD
            tiempoCPU: (p.tiempoCPU || 0) + 1
        }).catch(err => console.error(`Error al bloquear P${pid}:`, err));;
    }

    registrarEvento({
        tipo: 'switch',
        pid, nombre: p.nombre,
        estadoAnterior: 'LISTO', estadoNuevo: 'EJECUTANDO',
        pc: pcActual,
        pcAnterior: p.pcAnterior || 'inicio',
        pcNuevo: pcActual,
        quantumsRestantes: p.quantumsRestantes,
        quantumsTotales: p.quantumsTotales,
        mensaje: `Dispatcher: P${pid} (${p.nombre}) RESTAURA contexto en ${pcActual} → EJECUTANDO`
    });

    pulsarNucleo('running');
}

/**
 * TEMPORIZACIÓN (EJECUTANDO -> LISTO o SALIENTE)
 * 
 * Cuando se agota el quantum:
 * 1. Se GUARDA el contexto actual (PC, registros) en el BCP
 * 2. Se cambia estado a LISTO (o SALIENTE si no hay más quantums)
 * 3. El proceso regresa a la Cola de Listos
 * 4. El dispatcher selecciona el siguiente proceso
 */
function finalizarQuantum(pid) {
    const p = procesos[pid];
    if (!p) { cpu.pid = null; return; }

    const restante = p.quantumsRestantes - 1;

    const nuevoPC = cpu.pcEnVivo || avanzarPC(p.pc);
    const registrosFinales = cpu.registrosEnVivo || p.registros;
    const irFinal = cpu.irEnVivo || p.ir || '—';

    // 🔴 CAMBIO CLAVE: Actualizar la memoria local inmediatamente
    p.pcAnterior = p.pc;
    p.pc = nuevoPC;
    p.registros = registrosFinales;
    p.ir = irFinal;
    p.quantumsRestantes = restante;

    if (restante > 0) {
        if (typeof refProcesos !== 'undefined') {
            refProcesos.child(pid).update({ 
                estado: 'LISTO', 
                quantumsRestantes: restante, 
                pc: nuevoPC,
                pcAnterior: p.pcAnterior,
                registros: registrosFinales, 
                ir: irFinal,
                ordenListos: Date.now() 
            }).catch(err => console.error(`Error al bloquear P${pid}:`, err));;
        }
        registrarEvento({
            tipo: 'switch',
            pid, nombre: p.nombre,
            estadoAnterior: 'EJECUTANDO', estadoNuevo: 'LISTO',
            pc: nuevoPC,
            pcAnterior: p.pcAnterior,
            pcNuevo: nuevoPC,
            quantumsRestantes: restante,
            quantumsTotales: p.quantumsTotales,
            mensaje: `Timeout (${QUANTUM_MS/1000}s): P${pid} GUARDA contexto → Cola de Listos (Preemption)`
        });
    } else {
        if (typeof refProcesos !== 'undefined') {
            refProcesos.child(pid).update({ 
                estado: 'SALIENTE', 
                quantumsRestantes: 0, 
                pc: nuevoPC,
                registros: registrosFinales,
                ir: irFinal
            });
        }
        registrarEvento({
            tipo: 'terminate',
            pid, nombre: p.nombre,
            estadoAnterior: 'EJECUTANDO', estadoNuevo: 'SALIENTE',
            pc: nuevoPC,
            quantumsRestantes: 0,
            quantumsTotales: p.quantumsTotales,
            mensaje: `P${pid} (${p.nombre}) completa su ejecución → SALIENTE (Release)`
        });
        
        if (typeof refProcesos !== 'undefined') {
            setTimeout(() => refProcesos.child(pid).remove(), VIDA_TERMINADO_MS);
        }
    }

    pulsarNucleo(restante > 0 ? 'switch' : 'terminate');
    cpu.pid = null;
    cpu.fase = null;
    cpu.faseInicio = null;
    cpu.faseFin = null;
    cpu.pcEnVivo = null;
    cpu.irEnVivo = null;
    cpu.registrosEnVivo = null;
}

/**
 * BLOQUEO VOLUNTARIO A MITAD DE EJECUCIÓN (EJECUTANDO -> BLOQUEADO)
 * El proceso, en un instante aleatorio DENTRO de su fase de ejecución,
 * solicita una operación de E/S. Se GUARDA el contexto tal como está en
 * ese momento y la CPU queda libre para atender a otro proceso LISTO.
 */
function bloquearPorSolicitudES(pid) {
    const p = procesos[pid];
    if (!p) { cpu.pid = null; return; }

    const finBloqueo = Date.now() + TIEMPO_ESPERA_ES_MS;
    const pcActual = cpu.pcEnVivo || p.pc;
    const registrosActuales = cpu.registrosEnVivo || p.registros;
    const irActual = cpu.irEnVivo || p.ir || '—';

    if (typeof refProcesos !== 'undefined') {
        refProcesos.child(pid).update({
            estado: 'BLOQUEADO',
            pc: pcActual,
            pcAnterior: pcActual,
            registros: registrosActuales,
            ir: irActual,
            finBloqueo: finBloqueo
        }).catch(err => console.error(`Error al bloquear P${pid}:`, err));;
    }

    registrarEvento({
        tipo: 'interrupt', nivel: 1,
        pid, nombre: p.nombre,
        estadoAnterior: 'EJECUTANDO', estadoNuevo: 'BLOQUEADO',
        pc: pcActual,
        quantumsRestantes: p.quantumsRestantes,
        quantumsTotales: p.quantumsTotales,
        mensaje: `P${pid} (${p.nombre}) SOLICITA E/S a mitad de ejecución → GUARDA contexto → BLOQUEADO`
    });

    pulsarNucleo('switch');

    // Libera la CPU por completo; el proceso NO pierde quantums por esto,
    // solo queda pendiente de terminar esa instrucción cuando reanude.
    cpu.pid = null;
    cpu.fase = null;
    cpu.faseInicio = null;
    cpu.faseFin = null;
    cpu.pcEnVivo = null;
    cpu.irEnVivo = null;
    cpu.registrosEnVivo = null;
    cpu.momentoBloqueo = null;
}

/**
 * VIGILANTE DE CONSISTENCIA: corrige procesos "huérfanos" en estado EJECUTANDO
 * que ya no coinciden con lo que la CPU tiene realmente cargado (cpu.pid).
 * Esto puede pasar si un .update() a Firebase falla silenciosamente o si hay
 * una condición de carrera entre el dispatcher y el bloqueo/timeout.
 */
function corregirProcesosHuerfanos() {
    Object.values(procesos).forEach(p => {
        if (p.estado === 'EJECUTANDO' && String(p.pid) !== String(cpu.pid)) {
            console.warn(`⚠️ Proceso huérfano detectado: P${p.pid} estaba en EJECUTANDO pero la CPU tiene a P${cpu.pid}. Corrigiendo → LISTO.`);

            if (typeof refProcesos !== 'undefined') {
                refProcesos.child(p.pid).update({
                    estado: 'LISTO',
                    ordenListos: Date.now()
                }).catch(err => console.error('Error al corregir proceso huérfano:', err));
            }

            registrarEvento({
                tipo: 'switch',
                pid: p.pid, nombre: p.nombre,
                estadoAnterior: 'EJECUTANDO', estadoNuevo: 'LISTO',
                pc: p.pc,
                quantumsRestantes: p.quantumsRestantes,
                quantumsTotales: p.quantumsTotales,
                mensaje: `⚠️ P${p.pid} corregido automáticamente (estado inconsistente) → Cola de Listos`
            });
        }
    });
}

/**
 * FIN DE E/S AUTOMÁTICO: revisa procesos BLOQUEADOS cuyo tiempo de espera ya venció
 * y los regresa a LISTO (cola de listos), donde esperarán turno del dispatcher.
 */
function revisarFinDeBloqueos() {
    const ahora = Date.now();
    Object.values(procesos).forEach(p => {
        if (p.estado === 'BLOQUEADO' && p.finBloqueo && ahora >= p.finBloqueo) {
            if (typeof refProcesos !== 'undefined') {
                refProcesos.child(p.pid).update({
                    estado: 'LISTO',
                    ordenListos: Date.now(),
                    finBloqueo: null
                });
            }
            registrarEvento({
                tipo: 'switch',
                pid: p.pid, nombre: p.nombre,
                estadoAnterior: 'BLOQUEADO', estadoNuevo: 'LISTO',
                pc: p.pc,
                quantumsRestantes: p.quantumsRestantes,
                quantumsTotales: p.quantumsTotales,
                mensaje: `E/S completada: P${p.pid} despierta → Cola de Listos`
            });
        }
    });
}

/**
 * INTERRUPCIÓN POR E/S (EJECUTANDO -> BLOQUEADO)
 * 
 * Cuando llega una solicitud de E/S:
 * 1. Se GUARDA el contexto (PC, registros)
 * 2. Se cambia estado a BLOQUEADO
 * 3. El proceso entra en Cola de Bloqueados
 * 4. El dispatcher selecciona otro proceso LISTO
 */
function iniciarAtencionInterrupcion(interrupcion) {
    cpu.atendiendoInterrupcion = true;
    cpu.inicioAtencion = Date.now();
    cpu.finAtencion = cpu.inicioAtencion + TIEMPO_ATENCION_INTERRUPCION_MS;
    cpu.interruptId = interrupcion.id;
    cpu.nivelAtendido = interrupcion.nivel;
    cpu.pidBloqueado = null;

    if (cpu.pid) {
        const p = procesos[cpu.pid];
        // Se guarda el último PC/IR/Registros vistos en vivo (si el proceso
        // ya estaba en fase de EJECUCIÓN); si aún estaba en BÚSQUEDA, se
        // conserva el último contexto guardado en el BCP.
    let pcActual = cpu.pcEnVivo || p.pc || '10';
    if (pcActual === '0x1000') pcActual = '10';        const registrosActuales = cpu.registrosEnVivo || p.registros;
        const irActual = cpu.irEnVivo || p.ir || '—';

        if (typeof refProcesos !== 'undefined') {
            refProcesos.child(cpu.pid).update({ 
                estado: 'BLOQUEADO',
                pc: pcActual,
                pcAnterior: pcActual,  // ← GUARDAR para reanudación
                registros: registrosActuales,
                ir: irActual
            });
        }
        
        registrarEvento({
            tipo: 'interrupt', nivel: interrupcion.nivel,
            pid: cpu.pid, nombre: p.nombre,
            estadoAnterior: 'EJECUTANDO', estadoNuevo: 'BLOQUEADO',
            pc: pcActual,
            quantumsRestantes: p.quantumsRestantes,
            quantumsTotales: p.quantumsTotales,
            mensaje: `Interrupción E/S (Nivel ${interrupcion.nivel}): P${cpu.pid} GUARDA contexto → BLOQUEADO`
        });
        
        cpu.pidBloqueado = cpu.pid;
        cpu.pid = null;
        cpu.fase = null;
        cpu.faseInicio = null;
        cpu.faseFin = null;
        cpu.pcEnVivo = null;
        cpu.irEnVivo = null;
        cpu.registrosEnVivo = null;
        pulsarNucleo('switch');
    } else {
        pulsarNucleo('interrupt');
    }
}

/**
 * FIN DE E/S (BLOQUEADO -> LISTO)
 * 
 * Cuando termina la operación de E/S:
 * 1. El proceso despierta y regresa a Cola de Listos
 * 2. Contexto ya está guardado en el BCP
 * 3. Cuando sea seleccionado por el dispatcher, se restaurará
 */
function finalizarAtencionInterrupcion() {
    if (typeof refInterrupciones !== 'undefined') {
        refInterrupciones.child(cpu.interruptId).remove();
    }

    if (cpu.pidBloqueado) {
        const pid = cpu.pidBloqueado;
        const p = procesos[pid];
        if (p) {
            if (typeof refProcesos !== 'undefined') {
                refProcesos.child(pid).update({ 
                    estado: 'LISTO', 
                    ordenListos: Date.now() 
                });
            }
            registrarEvento({
                tipo: 'switch',
                pid, nombre: p.nombre,
                estadoAnterior: 'BLOQUEADO', estadoNuevo: 'LISTO',
                pc: p.pc,
                quantumsRestantes: p.quantumsRestantes,
                quantumsTotales: p.quantumsTotales,
                mensaje: `Evento I/O completado: P${pid} despierta → LISTO (Cola de Listos)`
            });
        }
    }

    cpu.atendiendoInterrupcion = false;
    cpu.finAtencion = null;
    cpu.inicioAtencion = null;
    cpu.nivelAtendido = null;
    cpu.interruptId = null;
    cpu.pidBloqueado = null;
}

// ============================================================================
// 9. CICLO PRINCIPAL (RELOJ DEL SISTEMA)
// ============================================================================
/**
 * Transiciona la CPU de fase BÚSQUEDA → EJECUCIÓN, y de EJECUCIÓN → fin de quantum.
 * Mientras haya un proceso cargado (cpu.pid), NO se revisan interrupciones:
 * eso es lo que garantiza la atomicidad de la fase de ejecución.
 */
/**
 * NOTA DE DISEÑO: el BCP "en vivo" ya NO cambia en cada tick (cada 100ms).
 * Un ciclo de instrucción real solo cambia sus datos en dos momentos:
 *   1) Al terminar la BÚSQUEDA: se "carga" la instrucción y los registros
 *      (una sola vez) → eso pasa en manejarFasesCPU(), abajo.
 *   2) Al terminar la EJECUCIÓN: la instrucción ya se ejecutó, así que
 *      cambian los registros y el PC avanza a la siguiente instrucción
 *      (una sola vez, también en manejarFasesCPU()).
 * Entre esos dos momentos (mientras dura cada fase) los valores se quedan
 * quietos en pantalla, que es justo lo que se ve en un procesador real.
 */
function manejarFasesCPU(ahora) {
    if (!cpu.faseFin || ahora < cpu.faseFin) return;

    if (cpu.fase === 'busqueda') {
        cpu.fase = 'ejecucion';
        cpu.faseInicio = ahora;
        cpu.faseFin = ahora + FASE_EJECUCION_MS;

        // Decide si este proceso, en ALGÚN punto de esta fase de ejecución,
        // va a solicitar E/S y bloquearse voluntariamente.
        if (Math.random() < PROB_SOLICITUD_ES) {
            // Momento aleatorio estrictamente dentro de la ventana de ejecución
            // (evita los extremos, para que se note visualmente el corte)
            const margen = 300; // ms de margen para no bloquear justo al inicio/fin
            const rango = FASE_EJECUCION_MS - margen * 2;
            cpu.momentoBloqueo = cpu.faseInicio + margen + Math.random() * rango;
        } else {
            cpu.momentoBloqueo = null;
        }

    } else if (cpu.fase === 'ejecucion') {
        const p = procesos[cpu.pid];
        if (p) {
            cpu.pcEnVivo = avanzarPC(cpu.pcEnVivo || p.pc);
            cpu.registrosEnVivo = registrosAleatorios();
            cpu.irEnVivo = instruccionAleatoria();
        }

        finalizarQuantum(cpu.pid);
    }
}

function tick() {
    if (simulacionPausada) return;

    procesarAdmisionNuevos();
    revisarFinDeBloqueos();
    corregirProcesosHuerfanos();

    const ahora = Date.now();

    if (cpu.atendiendoInterrupcion) {
        if (ahora >= cpu.finAtencion) {
            finalizarAtencionInterrupcion();
        }
        return;
    }

    // NUEVO: si el proceso en EJECUCIÓN tenía programado un bloqueo por E/S
    // y ya llegó ese instante, se bloquea aquí mismo (a mitad de instrucción).
    if (cpu.pid && cpu.fase === 'ejecucion' && cpu.momentoBloqueo && ahora >= cpu.momentoBloqueo) {
        bloquearPorSolicitudES(cpu.pid);
        return;
    }

    if (cpu.pid) {
        manejarFasesCPU(ahora);
        if (cpu.pid) return;
    }

    const pendientes = obtenerInterrupcionesOrdenadas();
    if (pendientes.length > 0) {
        iniciarAtencionInterrupcion(pendientes[0]);
        return;
    }

    const listos = obtenerColaListosOrdenada();
    if (listos.length > 0) {
        asignarCPU(listos[0].pid);
    }
}

setInterval(tick, TIEMPO_TICK_MS);

// ============================================================================
// 10. RENDERIZADO DE BCP (TABLA)
// ============================================================================
function renderBCP() {
    const body = document.getElementById('bcp-body');
    if (!body) return;

    const lista = Object.values(procesos).sort((a, b) => a.pid - b.pid);

    if (lista.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="bcp-empty">Aún no se han creado procesos. Escanea el QR desde tu teléfono.</td></tr>';
        return;
    }

    // Si lo único que hay es el placeholder de "vacío", límpialo antes de insertar filas reales.
    if (body.querySelector('.bcp-empty')) body.innerHTML = '';

    const estadoBadge = { 
        NUEVO: 'badge-new',
        EJECUTANDO: 'badge-running', 
        LISTO: 'badge-ready', 
        BLOQUEADO: 'badge-blocked', 
        SALIENTE: 'badge-terminated' 
    };

    const idsVistos = new Set();

    lista.forEach(p => {
        const filaId = 'bcp-row-' + p.pid;
        idsVistos.add(filaId);

        let fila = document.getElementById(filaId);
        if (!fila) {
            // Fila nueva: se crea UNA sola vez con su estructura fija.
            fila = document.createElement('tr');
            fila.id = filaId;
            fila.innerHTML = `
                <td><strong>P${p.pid}</strong></td>
                <td class="col-nombre"></td>
                <td class="col-estado"><span class="badge"></span></td>
                <td class="col-q" style="font-weight: 600; color: var(--text-dim);"></td> <!-- NUEVA CELDA -->
                <td class="col-prio"></td> <!-- CELDA DE PRIORIDAD QUE FALTABA -->
                <td class="col-pc"><code></code></td>
                <td class="col-ir"><code style="font-size: 0.85em;"></code></td>
                <td class="col-regs"><code style="font-size: 0.8em;"></code></td>
            `;
            body.appendChild(fila);
        }

        // Elegir el color del parpadeo dependiendo del estado actual del proceso
        let claseFlash = '';
        if (pidsConFlash.has(String(p.pid))) {
            // Si el proceso acaba de pasar a EJECUTANDO, resalta en celeste.
            // Si acaba de volver a LISTO o BLOQUEADO (guardando BCP), resalta en ámbar.
            claseFlash = (p.estado === 'EJECUTANDO') ? 'row-flash-cyan' : 'row-flash-amber';
        }

        // Aplicamos las clases correspondientes a la fila
        fila.className = (p.estado === 'SALIENTE' ? 'row-terminated ' : '') + claseFlash;

        const regs = p.registros;
        const cln = v => (v === '0x0000' || v === '0x00' || String(v).startsWith('0x')) ? 0 : v;
        const regsTexto = regs ? `AX:${cln(regs.AX)} BX:${cln(regs.BX)} CX:${cln(regs.CX)} DX:${cln(regs.DX)}` : '—';
        const badge = fila.querySelector('.col-estado .badge');

        fila.querySelector('.col-nombre').textContent = p.nombre;
        badge.className = `badge ${estadoBadge[p.estado] || ''}`;
        badge.textContent = p.estado;

        // LLENAR LA NUEVA COLUMNA CON LOS QUANTUMS RESTANTES
        fila.querySelector('.col-q').textContent = p.quantumsRestantes !== undefined ? p.quantumsRestantes : '—';

        const nivelPrio = p.prioridad || 2; 
        let textoPrio = nivelPrio === 1 ? '🔴 Alta' : (nivelPrio === 2 ? '🟡 Media' : '🟢 Baja');
        fila.querySelector('.col-prio').textContent = textoPrio;

        let pcLimpio = p.pc || '10';
        if (pcLimpio === '0x1000') pcLimpio = '10';
        fila.querySelector('.col-pc code').textContent = pcLimpio;
        fila.querySelector('.col-ir code').textContent = p.ir || '—';
        fila.querySelector('.col-regs code').textContent = regsTexto;
    });

    // Quitar filas de procesos que ya no existen (ej. SALIENTE eliminado tras VIDA_TERMINADO_MS).
    Array.from(body.children).forEach(tr => {
        if (tr.id && !idsVistos.has(tr.id)) tr.remove();
    });
}

// ============================================================================
// 11. CONTROLES DEL HOST
// ============================================================================
window.togglePausa = function() {
    simulacionPausada = !simulacionPausada;
    const btn = document.getElementById('btn-pausa');
    const btnPaso = document.getElementById('btn-paso'); // NUEVA REFERENCIA

    if (simulacionPausada) {
        // Se pausa EN ESTE INSTANTE
        cpu.pausadoDesde = Date.now();
        if (btnPaso) btnPaso.style.display = 'inline-flex'; // NUEVO: Mostrar botón
    } else if (cpu.pausadoDesde) {
        // Al reanudar, se desplazan todos los temporizadores
        const delta = Date.now() - cpu.pausadoDesde;
        if (cpu.faseFin) cpu.faseFin += delta;
        if (cpu.finAtencion) cpu.finAtencion += delta;

        if (typeof refProcesos !== 'undefined') {
            const ahora = Date.now(); // CAPTURAMOS EL TIEMPO ACTUAL
            Object.values(procesos).forEach(p => {
                if (p.estado === 'NUEVO' && p.creadoEn) {
                    // VALIDACIÓN PARA EVITAR EL BUG DEL FUTURO
                    if (p.creadoEn < cpu.pausadoDesde) {
                        refProcesos.child(p.pid).update({ creadoEn: p.creadoEn + delta });
                    } else {
                        refProcesos.child(p.pid).update({ creadoEn: ahora });
                    }
                }
            });
        }
        cpu.pausadoDesde = null;
        if (btnPaso) btnPaso.style.display = 'none'; // NUEVO: Ocultar botón
    }

    if (btn) {
        if (simulacionPausada) {
            btn.textContent = '▶ Reanudar simulación';
            btn.classList.add('active-pause');
        } else {
            btn.textContent = '⏸ Pausar simulación';
            btn.classList.remove('active-pause');
        }
    }
};

window.ejecutarUnQuantum = function() {
    if (!simulacionPausada) return;

    const btnPaso = document.getElementById('btn-paso');
    if (btnPaso) {
        btnPaso.disabled = true;
        btnPaso.innerHTML = "⏳ Ejecutando ciclo...";
    }

    // 1. Tomamos una "fotografía" de quién está en el CPU antes de reanudar
    const pidInicial = typeof cpu !== 'undefined' && cpu ? cpu.pid : null;
    // Asumo que la variable de la fase se llama 'fase' o 'estado', ajusta si es necesario
    let fasePrevia = typeof cpu !== 'undefined' && cpu ? (cpu.fase || cpu.estado) : null; 

    // 2. Quitamos la pausa. La simulación corre de forma natural con sus propias animaciones.
    togglePausa(); 

    // 3. Creamos el vigilante que revisa el núcleo cada 20ms
    const vigilante = setInterval(() => {
        // Prevención: si pausas manualmente mientras se ejecutaba el paso, cancelamos el vigilante
        if (simulacionPausada) {
            clearInterval(vigilante);
            if (btnPaso) {
                btnPaso.disabled = false;
                btnPaso.innerHTML = "⏭ Avanzar 1 Quantum";
            }
            return;
        }

        const pidActual = cpu ? cpu.pid : null;
        const faseActual = cpu ? (cpu.fase || cpu.estado) : null;

        let debePausar = false;

        // Condición A: Hubo un cambio de contexto (entró un proceso nuevo o el CPU quedó vacío)
        if (pidActual !== pidInicial) {
            debePausar = true;
        } 
        // Condición B: Es el MISMO proceso, pero acaba de terminar su fase de "Ejecución" 
        // y se reinició su ciclo para la siguiente instrucción o quantum.
        else if (pidActual === pidInicial && pidActual !== null) {
            if ((fasePrevia === 'EJECUCION' || fasePrevia === 'EJECUCIÓN') && 
                (faseActual !== 'EJECUCION' && faseActual !== 'EJECUCIÓN')) {
                debePausar = true;
            }
        }

        fasePrevia = faseActual;

        // 4. Si el ciclo / quantum terminó, volvemos a pausar
        if (debePausar) {
            clearInterval(vigilante);
            
            // Damos un respiro exacto de 150ms. 
            // Esto permite que el DOM inyecte las clases de animación que tienes en tu CSS 
            // (row-flash-cyan para cuando pasa a EJECUTANDO y row-flash-amber para cuando 
            // guarda contexto) antes de congelar el JavaScript.
            setTimeout(() => {
                if (!simulacionPausada) {
                    togglePausa(); // Congelamos la pantalla de nuevo
                }
                
                // Restauramos el botón
                if (btnPaso) {
                    btnPaso.disabled = false;
                    btnPaso.innerHTML = "⏭ Avanzar 1 Quantum";
                }
            }, 150);
        }
    }, 20);
};

/**
 * Cierra o reabre la recepción de nuevos procesos e interrupciones.
 * Esta bandera se guarda en Firebase (ruta "config/recepcionCerrada") para
 * que el teléfono (cliente) la lea y bloquee sus botones de envío.
 * IMPORTANTE: esta función solo AVISA la intención desde el host. El
 * bloqueo real ocurre en el script del cliente (teléfono), que debe
 * consultar esta misma ruta antes de dejar enviar un proceso o interrupción.
 */
window.toggleRecepcion = function() {
    if (!refConfig) {
        alert('No se encontró conexión con la base de datos (config). Revisa firebase-config.js.');
        return;
    }
    refConfig.child('recepcionCerrada').set(!recepcionCerrada);
};

function actualizarBotonRecepcion() {
    const btn = document.getElementById('btn-recepcion');
    if (!btn) return;
    if (recepcionCerrada) {
        btn.textContent = '🔓 Reabrir recepción';
        btn.classList.add('active-block');
    } else {
        btn.textContent = '🔒 Cerrar recepción';
        btn.classList.remove('active-block');
    }
}

window.limpiarProcesos = function() {
    if (confirm("¿Eliminar todos los procesos e interrupciones?")) {
        if (typeof refProcesos !== 'undefined') refProcesos.remove();
        if (typeof refInterrupciones !== 'undefined') refInterrupciones.remove();
        if (typeof refEventos !== 'undefined') refEventos.remove();
        if (typeof refContadorPID !== 'undefined') refContadorPID.set(0);
        
        const timeline = document.getElementById('timeline');
        if (timeline) timeline.innerHTML = '';
        
        cpu.pid = null;
        cpu.fase = null;
        cpu.faseInicio = null;
        cpu.faseFin = null;
        cpu.atendiendoInterrupcion = false;
        cpu.finAtencion = null;
        cpu.interruptId = null;
        cpu.pidBloqueado = null;
        cpu.pausadoDesde = null;
        
        renderBCP();
        renderColas();
        pulsarNucleo('terminate');
        actualizarNucleo();
    }
};

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    renderBCP();
    renderColas();
    actualizarNucleo();
    generarQR();
    actualizarBotonRecepcion();
});