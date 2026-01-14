/**
 * @fileoverview ETL v10.0 - Temporal Mass Balance & Multitasking Aggregation.
 * @description Pipeline de extracción de datos de Google Calendar para calcular
 * la utilización del tiempo (lineal vs. solapado) y generar reportes de productividad.
 * @author Javi Giraldo
 * @version 10.0.0 (Production)
 */

// ==========================================
// 1. CONFIGURACIÓN DEL ENTORNO (CONFIG)
// ==========================================
const CONFIG = {
  // Destinatarios del reporte
  EMAIL_PRIMARY: "tu_email@ejemplo.com", 
  EMAIL_CC: "tu_email_secundario@ejemplo.com", // Opcional
  
  // Configuración de la hoja de cálculo
  SHEET_NAME: "DashData_Prod",
  
  // Parámetros de reporte
  USER_NAME: "Javi",
  TIMEZONE: "GMT-5",
  
  // Filtros de Calendario (Exclusiones)
  IGNORED_CALENDARS: ["holiday", "group.v.calendar", "Contacts", "Birthdays"]
};

/**
 * Función Principal (Orquestador ETL).
 * Extrae eventos, calcula métricas de tiempo y actualiza el Data Warehouse (Sheets).
 */
function updateAllMetrics() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }
  sheet.clear();

  const now = new Date();
  const meses = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
  const mesMayuscula = meses[now.getMonth()];

  // DEFINICIÓN DE SCHEMA (Headers)
  sheet.getRange("A1:G1").setValues([["HOY", "", "ESTA SEMANA", "", "ESTE MES", "", "METADATA"]]);
  sheet.getRange("A1:G1").setFontWeight("bold").setBackground("#4a90e2").setFontColor("white");
  sheet.appendRow(["Categoría", "Horas", "Categoría", "Horas", "Categoría", "Horas", "Última Actualización"]);
  
  // DEFINICIÓN DE VENTANAS DE TIEMPO (Time Windows)
  // 1. Diario (Today)
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  // 2. Semanal (Week to Date)
  const dayOfWeek = now.getDay();
  const diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
  const startWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0);
  const endWeek = new Date(startWeek.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

  // 3. Mensual (Month to Date)
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Potencial Lineal (Capacidad máxima del reloj)
  const ranges = {
    diario: { start: startToday, end: endToday, pot: 24 },
    semanal: { start: startWeek, end: endWeek, pot: 24 * 7 },
    mensual: { start: startMonth, end: endMonth, pot: 24 * 30 }
  };

  // EXTRACTION (Calendar API)
  const calendars = CalendarApp.getAllCalendars().filter(cal => {
    const n = cal.getName();
    const id = cal.getId();
    // Filtro de exclusión basado en CONFIG
    return !CONFIG.IGNORED_CALENDARS.some(ignore => id.includes(ignore) || n === ignore) && n !== id;
  });

  let results = { diario: {}, semanal: {}, mensual: {} };

  // TRANSFORMATION (Logic Core)
  Object.keys(ranges).forEach(rangeKey => {
    let allIntervals = [];
    const r = ranges[rangeKey];

    calendars.forEach(cal => {
      const events = cal.getEvents(r.start, r.end);
      let catTotal = 0;
      
      events.forEach(e => {
        if (e.isAllDayEvent()) return;
        
        // Truncamiento estricto (Clipping)
        const s = new Date(Math.max(e.getStartTime(), r.start));
        const et = new Date(Math.min(e.getEndTime(), r.end));

        if (s < et) {
          const duration = (et - s) / (1000 * 60 * 60);
          catTotal += duration;
          // Guardar intervalo para cálculo de "Gap Analysis"
          allIntervals.push({s: s.getTime(), e: et.getTime()});
        }
      });

      if (catTotal > 0) {
        // Acumulación por Calendario (Permite > 24h si hay solapamiento)
        results[rangeKey][cal.getName()] = (results[rangeKey][cal.getName()] || 0) + catTotal;
      }
    });

    // CÁLCULO DE TIEMPO LIBRE (Linear Free Time)
    // Algoritmo de fusión de intervalos para determinar ocupación real del reloj
    results[rangeKey]["Tiempo Libre"] = calculateLinearFreeTime(allIntervals, r.pot);
  });

  // LOAD (Render)
  renderTable(sheet, results, now);

  // KPI Headers
  sheet.getRange("H1").setValue("BALANCE DE HOY:").setFontWeight("bold");
  sheet.getRange("H12").setValue("BALANCE DE ESTA SEMANA:").setFontWeight("bold");
  sheet.getRange("H23").setValue(`BALANCE DE ${mesMayuscula}:`).setFontWeight("bold");  
}

/**
 * Helper: Algoritmo de Fusión de Intervalos.
 * Une intervalos solapados para calcular ocupación lineal absoluta.
 * @param {Array} intervals - Array de objetos {s: start, e: end} en ms.
 * @param {number} potential - Capacidad total en horas del periodo.
 * @return {string} Horas libres disponibles (formato string decimal).
 */
function calculateLinearFreeTime(intervals, potential) {
  if (intervals.length === 0) return potential.toFixed(2);
  
  // Ordenar por inicio
  intervals.sort((a, b) => a.s - b.s);
  
  let merged = [];
  let current = intervals[0];

  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].s < current.e) {
      // Solapamiento detectado: Extender final del intervalo actual
      current.e = Math.max(current.e, intervals[i].e);
    } else {
      // No solapamiento: Guardar actual e iniciar nuevo
      merged.push(current);
      current = intervals[i];
    }
  }
  merged.push(current);

  const busyHours = merged.reduce((sum, inv) => sum + (inv.e - inv.s), 0) / (1000 * 60 * 60);
  const freeTime = potential - busyHours;
  
  return (freeTime > 0 ? freeTime : 0).toFixed(2);
}

/**
 * Helper: Renderizado de Tabla.
 * Escribe los resultados en columnas paralelas en la hoja de cálculo.
 */
function renderTable(sheet, data, now) {
  const dKeys = Object.keys(data.diario);
  const sKeys = Object.keys(data.semanal);
  const mKeys = Object.keys(data.mensual);
  const max = Math.max(dKeys.length, sKeys.length, mKeys.length);

  for (let i = 0; i < max; i++) {
    sheet.appendRow([
      dKeys[i] || "", dKeys[i] ? Number(data.diario[dKeys[i]]).toFixed(2) : "",
      sKeys[i] || "", sKeys[i] ? Number(data.semanal[sKeys[i]]).toFixed(2) : "",
      mKeys[i] || "", mKeys[i] ? Number(data.mensual[mKeys[i]]).toFixed(2) : "",
      i === 0 ? now.toLocaleString() : "" // Timestamp solo en primera fila
    ]);
  }
  sheet.autoResizeColumns(1, 7);
}

/**
 * Trigger de Reporte Semanal.
 * Genera snapshot PDF y notifica por email.
 */
function sendWeeklyReport() {
  Logger.log("Iniciando generación de reporte semanal...");
  
  // 1. ETL Update
  updateAllMetrics();
  
  // 2. PDF Generation
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const fecha = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "dd/MM/yyyy");
  const subject = `REPORTE DE PRODUCTIVIDAD: SEMANA ${fecha}`;
  
  const blob = ss.getAs('application/pdf').setName(`Productivity_Report_${fecha.replace(/\//g,'-')}.pdf`);
  
  // 3. Email Body Construction
  const body = `REPORTE DE MÉTRICAS DE RENDIMIENTO\n` +
               `===================================\n` +
               `Usuario: ${CONFIG.USER_NAME}\n` +
               `Fecha de corte: ${fecha}\n\n` +
               `El sistema ha calculado el balance de masa temporal:\n` +
               `1. Sumatoria Multitasking: Carga total por categoría (puede exceder 24h/día).\n` +
               `2. Tiempo Lineal Libre: Capacidad restante real del reloj (Gap Analysis).\n\n` +
               `Adjunto encontrará el desglose detallado.\n\n` +
               `--\n` +
               `Data Intelligence System | Google Apps Script`;

  // 4. Distribution
  GmailApp.sendEmail(CONFIG.EMAIL_PRIMARY, subject, body, {
    attachments: [blob],
    name: "Productivity Bot",
    cc: CONFIG.EMAIL_CC
  });
}
