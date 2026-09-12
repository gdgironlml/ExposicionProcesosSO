/* ==========================================================================
   CONFIGURACIÓN DE FIREBASE REALTIME DATABASE
   ==========================================================================
   Este archivo es compartido por host.html (proyector) y client.html
   (teléfono del estudiante). Ambos escriben y leen del mismo árbol de datos
   en tiempo real, lo que permite que las acciones del celular se reflejen
   de inmediato en la pantalla del proyector.

   PASOS PARA CONFIGURAR TU PROPIO PROYECTO:
   1. Entra a https://console.firebase.google.com/ e inicia sesión.
   2. Crea un proyecto nuevo (o reutiliza uno existente).
   3. En el menú lateral entra a "Realtime Database" > "Crear base de datos".
      Elige la ubicación y selecciona "Iniciar en modo de prueba" (para que
      la demo funcione sin configurar reglas de seguridad complejas).
   4. Ve a "Configuración del proyecto" (ícono de engranaje) > pestaña
      "General" > sección "Tus apps" > agrega una app Web (</>).
   5. Copia el objeto "firebaseConfig" que Firebase te entrega y pégalo
      reemplazando los valores de ejemplo de abajo.
   6. Sube este proyecto a un hosting (Firebase Hosting, GitHub Pages, etc.)
      o ábrelo en tu red local; host.html generará el QR automáticamente
      usando la URL donde se está ejecutando.
   ========================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCA5OVsZ-B0Nrc0Hd2UqDxK91GI8xlsdBI",
  authDomain: "exposicion-procesos-so.firebaseapp.com",
  databaseURL: "https://exposicion-procesos-so-default-rtdb.firebaseio.com",
  projectId: "exposicion-procesos-so",
  storageBucket: "exposicion-procesos-so.firebasestorage.app",
  messagingSenderId: "677031973514",
  appId: "1:677031973514:web:922da050c8c644b6155373"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
/* --------------------------------------------------------------------------
   REFERENCIAS A LOS NODOS PRINCIPALES DEL ÁRBOL DE DATOS
   --------------------------------------------------------------------------
   procesos/{pid}     -> Bloque de Control de Proceso (BCP) ACTUAL de cada
                          proceso (foto del presente; sí se sobreescribe).
   contadorPID         -> Contador atómico para asignar PIDs únicos.
   interrupciones/{id} -> Cola de interrupciones de hardware pendientes.
   eventos/{id}        -> Bitácora PERMANENTE de todo lo que ha pasado.
                          Nunca se borra ni se sobreescribe: cada cambio de
                          contexto, interrupción o terminación agrega una
                          entrada nueva, así se puede ver el "por qué" de
                          cada transición aunque el BCP actual ya cambió.
   control             -> { pausado, aceptandoSolicitudes } — controlado
                          por el presentador desde host.html.
   -------------------------------------------------------------------------- */
const refProcesos = db.ref('procesos');
const refContadorPID = db.ref('contadorPID');
const refInterrupciones = db.ref('interrupciones');
const refEventos = db.ref('eventos');
const refControl = db.ref('control');

/**
 * Registra un evento PERMANENTE en la línea de tiempo del sistema.
 * Nunca se elimina ni se actualiza: es el historial de "por qué pasó cada
 * cosa", independiente del estado actual (que sí cambia) en /procesos.
 *
 * @param {Object} datos
 * @param {string} datos.mensaje          Explicación en palabras del evento.
 * @param {string} datos.tipo             'create' | 'switch' | 'interrupt' | 'terminate' | 'info'
 * @param {number} [datos.nivel]          Nivel de la interrupción (1-3), si aplica.
 * @param {number} [datos.pid]            PID del proceso involucrado.
 * @param {string} [datos.nombre]         Nombre del proceso involucrado.
 * @param {string} [datos.estadoAnterior] Estado antes de este evento.
 * @param {string} [datos.estadoNuevo]    Estado después de este evento.
 * @param {string} [datos.pc]             PC del proceso en este momento.
 * @param {number} [datos.quantumsRestantes]
 * @param {number} [datos.quantumsTotales]
 */
function registrarEvento(datos) {
  refEventos.push({ ...datos, timestamp: Date.now() });
}
