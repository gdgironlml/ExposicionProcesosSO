// ============================================================================
// client.js - Lógica del Cliente Móvil (Estudiante / Usuario)
// ============================================================================

let recepcionCerrada = false;
let refConfig;

// Variables de estado local para Cooldown y Sincronización Global
let cooldownProceso = false;
let cooldownInterrupcion = false;
let procesosGlobales = {};
let interrupcionesGlobales = {};

if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
    refConfig = firebase.database().ref('config');
}

// ----------------------------------------------------------------------------
// LISTENERS EN TIEMPO REAL (Límites globales de 6 procesos y 3 interrupciones)
// ----------------------------------------------------------------------------
if (typeof refConfig !== 'undefined') {
    refConfig.child('recepcionCerrada').on('value', snapshot => {
        recepcionCerrada = snapshot.val() === true;
        if (recepcionCerrada) {
            mostrarMensaje('🔒 La recepción de procesos está desactivada por el profesor.');
        } else {
            ocultarMensaje();
        }
    });
}

// Escuchar los procesos activos en tiempo real
if (typeof refProcesos !== 'undefined') {
    refProcesos.on('value', snapshot => {
        procesosGlobales = snapshot.val() || {};
    });
}

// Escuchar las interrupciones pendientes en tiempo real
if (typeof refInterrupciones !== 'undefined') {
    refInterrupciones.on('value', snapshot => {
        interrupcionesGlobales = snapshot.val() || {};
    });
}

// ============================================================================
// FUNCIONES DE CONTROL CON COOLDOWN, LÍMITES Y BLOQUEO DE DUPLICADOS
// ============================================================================

/**
 * Solicita la creación de un proceso aplicando:
 * 1. Cooldown local de 10s.
 * 2. Límite máximo global de 6 procesos.
 * 3. Verificación de duplicados por nombre de programa.
 * 4. Asignación de 1 Quantum si es Prioridad Alta (🔴).
 */
async function solicitarCrearProceso() {
    if (recepcionCerrada) {
        mostrarMensaje('🔒 El profesor cerró la recepción.');
        return;
    }

    // A) Control de Cooldown (10 segundos)
    if (cooldownProceso) {
        mostrarMensaje('⏳ Debes esperar a que termine el temporizador de 10s.');
        return;
    }

    const select = document.getElementById('select-proceso');
    if (!select) return;

    const opcionSeleccionada = select.options[select.selectedIndex];
    const nombre = opcionSeleccionada.value;
    const prioridad = parseInt(opcionSeleccionada.getAttribute('data-prio')) || 2;

    // B) Control de Duplicados (Bloquea si ya existe un proceso activo con ese nombre)
    const existeDuplicado = Object.values(procesosGlobales).some(
        p => p.nombre === nombre && p.estado !== 'SALIENTE'
    );
    if (existeDuplicado) {
        mostrarMensaje(`⚠️ El programa "${nombre}" ya está en ejecución o en cola. Elige otro.`);
        return;
    }

    // C) Control de Máximo 6 Procesos Activos (Contando solo los que no han finalizado)
    const procesosActivos = Object.values(procesosGlobales).filter(p => p.estado !== 'SALIENTE');
    if (procesosActivos.length >= 4) {
        mostrarMensaje('🚫 Límite alcanzado: Ya hay 6 procesos en el sistema. Espera a que termine uno.');
        return;
    }

    // Regla de Quantums: Prioridad Alta (1) = 1 Quantum. Media/Baja = Entre 2 y 6.
    const quantums = (prioridad === 1) ? 1 : (prioridad === 2) ? 2 : 3;
    try {
        const pid = await crearProceso(nombre, quantums, prioridad);
        let prioTexto = prioridad === 1 ? '🔴 Alta' : prioridad === 2 ? '🟡 Media' : '🟢 Baja';
        mostrarMensaje(`✅ Ejecutando "${nombre}" [${prioTexto}] → Proceso P${pid} creado (${quantums}Q).`);

        // Iniciar Cooldown de 10 segundos
        iniciarCooldown('proceso', 10);

    } catch (error) {
        mostrarMensaje(`❌ Error al crear proceso: ${error.message || 'Intenta nuevamente'}`);
    }
}
window.solicitarCrearProceso = solicitarCrearProceso;

/**
 * Solicita el envío de una interrupción aplicando:
 * 1. Cooldown local de 10s.
 * 2. Límite máximo global de 3 interrupciones.
 * 3. Verificación de duplicados (evita saturar con el mismo nivel si ya está pendiente).
 */
function solicitarEnviarInterrupcion() {
    if (recepcionCerrada) {
        mostrarMensaje('🔒 El profesor cerró la recepción.');
        return;
    }

    // A) Control de Cooldown (10 segundos)
    if (cooldownInterrupcion) {
        mostrarMensaje('⏳ Debes esperar a que termine el temporizador de 10s.');
        return;
    }

    const select = document.getElementById('select-interrupcion');
    if (!select) return;

    const nivel = parseInt(select.value, 10);
    const listaInterrupciones = Object.values(interrupcionesGlobales);

    // B) Control de Máximo 3 Interrupciones en Cola
    if (listaInterrupciones.length >= 3) {
        mostrarMensaje('🛑 Límite alcanzado: Ya hay 3 interrupciones pendientes en el sistema.');
        return;
    }

    // C) Control de Duplicados (Bloquea si ya hay una interrupción del mismo nivel pendiente)
    const yaExisteMismoNivel = listaInterrupciones.some(i => parseInt(i.nivel, 10) === nivel);
    if (yaExisteMismoNivel) {
        mostrarMensaje(`⚠️ Ya hay una interrupción de Nivel ${nivel} pendiente por atender en el SO.`);
        return;
    }

    enviarInterrupcionIO(nivel);
    iniciarCooldown('interrupcion', 10);
}
window.solicitarEnviarInterrupcion = solicitarEnviarInterrupcion;

// ============================================================================
// GESTOR DE TEMPORIZADORES (COOLDOWN VISUAL)
// ============================================================================

function iniciarCooldown(tipo, segundos) {
    let restante = segundos;
    
    // Identificamos el botón según el tipo de acción
    const btn = (tipo === 'proceso') 
        ? document.querySelector('#form-proceso button, .btn-crear-proceso, button[onclick*="solicitarCrearProceso"]')
        : document.querySelector('#form-interrupcion button, .btn-enviar-int, button[onclick*="solicitarEnviarInterrupcion"]');
    
    const textoOriginal = btn ? btn.textContent : '';

    if (tipo === 'proceso') cooldownProceso = true;
    if (tipo === 'interrupcion') cooldownInterrupcion = true;

    if (btn) btn.disabled = true;

    const contador = setInterval(() => {
        if (btn) btn.textContent = `⏳ Espera (${restante}s)`;
        restante--;

        if (restante < 0) {
            clearInterval(contador);
            if (tipo === 'proceso') cooldownProceso = false;
            if (tipo === 'interrupcion') cooldownInterrupcion = false;

            if (btn) {
                btn.disabled = false;
                btn.textContent = textoOriginal;
            }
        }
    }, 1000);
}

// ============================================================================
// FUNCIONES BACKEND (Creación y registro en Firebase)
// ============================================================================

function generarLimiteMemoria() {
    const base = Math.floor(Math.random() * 0xE000);
    const tam = 0x0800 + Math.floor(Math.random() * 0x1800);
    return `0x${base.toString(16).toUpperCase().padStart(4, '0')}–0x${(base + tam).toString(16).toUpperCase().padStart(4, '0')}`;
}

function generarArchivosAbiertos() {
    const posibles = ['datos.dat', 'config.sys', 'log.txt', 'cache.tmp'];
    const cantidad = Math.floor(Math.random() * 3);
    const elegidos = [];
    for (let i = 0; i < cantidad; i++) {
        const f = posibles[Math.floor(Math.random() * posibles.length)];
        if (!elegidos.includes(f)) elegidos.push(f);
    }
    return elegidos;
}

async function crearProceso(nombre, quantums, prioridad) {
    try {
        const resultado = await refContadorPID.transaction(actual => (actual || 0) + 1);
        if (!resultado.committed) {
            throw new Error('No se pudo obtener PID');
        }
        const pid = resultado.snapshot.val();

        const nuevoProceso = {
            pid: pid,
            nombre: nombre,
            estado: 'NUEVO',
            pc: '0x1000',
            pcAnterior: null,
            registros: { AX: '0x0000', BX: '0x0000', CX: '0x0000', DX: '0x0000' },
            quantumsTotales: quantums,
            quantumsRestantes: quantums,
            prioridad: prioridad,
            limiteMemoria: generarLimiteMemoria(),
            archivosAbiertos: generarArchivosAbiertos(),
            tiempoCPU: 0,
            ordenListos: Date.now(),
            creadoEn: Date.now()
        };

        await refProcesos.child(pid).set(nuevoProceso);
        
        if (typeof registrarEvento !== 'undefined') {
            registrarEvento({
                tipo: 'create',
                pid: pid, 
                nombre: nombre,
                estadoAnterior: 'NULL',
                estadoNuevo: 'NUEVO',
                pc: nuevoProceso.pc,
                quantumsRestantes: quantums, 
                quantumsTotales: quantums,
                mensaje: `📝 Proceso P${pid} (${nombre}) creado en estado NUEVO.`
            });
        }

        return pid;
    } catch (error) {
        console.error('Error al crear proceso:', error);
        throw error;
    }
}

function enviarInterrupcionIO(nivel) {
    try {
        refInterrupciones.push({
            nivel: nivel,
            timestamp: Date.now(),
            origen: 'cliente'
        });

        const nivelNombre = {
            1: 'Baja (Teclado/Mouse)',
            2: 'Media (Disco/Red)',
            3: 'Alta (Fallo Hardware)'
        };

        mostrarMensaje(`⚡ Interrupción enviada (Nivel ${nivel} - ${nivelNombre[nivel]}).`);
    } catch (error) {
        console.error('Error al enviar interrupción:', error);
        mostrarMensaje('❌ No se pudo enviar la interrupción.');
    }
}

// ============================================================================
// MANEJO DE MENSAJES DE FEEDBACK
// ============================================================================

function mostrarMensaje(texto) {
    const feedbackEl = document.getElementById('feedback-mensaje');
    if (!feedbackEl) return;
    
    feedbackEl.textContent = texto;
    feedbackEl.style.display = 'block';
    
    feedbackEl.onclick = () => {
        feedbackEl.style.display = 'none';
        feedbackEl.textContent = '';
    };
}

function ocultarMensaje() {
    const feedbackEl = document.getElementById('feedback-mensaje');
    if (!feedbackEl) return;
    
    feedbackEl.style.display = 'none';
    feedbackEl.textContent = '';
}