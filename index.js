/**
 * ARTURITO AI — Tickets por correo electrónico
 * Cloud Functions: recepción IMAP + respuesta SMTP + prueba de configuración
 */
const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const STAFF_ROLES = ['SuperAdmin', 'Administrador', 'Supervisor', 'Operador', 'Conserje', 'Comité'];

function fail(code, message) {
  throw new HttpsError(code, message);
}

function cfgPath(condominioId) {
  return `condominios/${condominioId}/email_config/main`;
}

function metaPath(condominioId) {
  return `condominios/${condominioId}/email_meta/main`;
}

function ticketsCol(condominioId) {
  return db.collection(`condominios/${condominioId}/tickets`);
}

function notificationsCol(condominioId) {
  return db.collection(`condominios/${condominioId}/notifications`);
}

async function assertStaff(uid) {
  if (!uid) fail('unauthenticated', 'Debe iniciar sesión');
  const snap = await db.doc(`users/${uid}`).get();
  const role = snap.data()?.rol;
  if (!STAFF_ROLES.includes(role)) {
    fail('permission-denied', 'No tienes permisos de administración');
  }
  return snap.data();
}

async function loadEmailConfig(condominioId) {
  const snap = await db.doc(cfgPath(condominioId)).get();
  if (!snap.exists) return null;
  const cfg = snap.data();
  if (cfg.enabled === false) return null;
  if (!cfg.smtpHost || !cfg.user || !cfg.password) return null;
  return cfg;
}

function imapDefaults(cfg) {
  return {
    host: cfg.imapHost || (cfg.smtpHost?.includes('gmail') ? 'imap.gmail.com' : cfg.smtpHost),
    port: cfg.imapPort || 993,
    secure: cfg.imapSecure !== false
  };
}

function createTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort || 587,
    secure: cfg.smtpSecure === true,
    auth: { user: cfg.user, pass: cfg.password }
  });
}

async function nextTicketNumber(condominioId) {
  const ref = db.doc(metaPath(condominioId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data().lastTicketNumber || 0) : 0;
    const next = current + 1;
    tx.set(ref, {
      lastTicketNumber: next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return `TK-${String(next).padStart(6, '0')}`;
  });
}

/** Extrae número secuencial de TK-000042 o TK-20250613-0003 (legado) */
function parseTicketSequence(value) {
  const s = String(value || '').trim();
  let m = s.match(/^TK-(\d{6})$/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/^TK-\d{8}-(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  return 0;
}

async function syncTicketCounterFromTickets(condominioId) {
  const snap = await ticketsCol(condominioId).get();
  let max = 0;
  snap.docs.forEach((d) => {
    const data = d.data();
    max = Math.max(
      max,
      parseTicketSequence(data.numeroTicket),
      parseTicketSequence(data.id),
      parseTicketSequence(d.id)
    );
  });
  const metaRef = db.doc(metaPath(condominioId));
  await db.runTransaction(async (tx) => {
    const meta = await tx.get(metaRef);
    const stored = meta.exists ? (meta.data().lastTicketNumber || 0) : 0;
    const next = Math.max(stored, max);
    tx.set(metaRef, {
      lastTicketNumber: next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return max;
}

function extractTicketRef(subject) {
  const m = String(subject || '').match(/\b(TK-\d{6})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function uploadAttachment(condominioId, ticketId, attachment) {
  if (!attachment?.content?.length) return null;
  const safeName = String(attachment.filename || 'adjunto').replace(/[^\w.\-() ]/g, '_').slice(0, 120);
  const path = `condominios/${condominioId}/tickets/${ticketId}/${Date.now()}_${safeName}`;
  const file = bucket.file(path);
  await file.save(attachment.content, {
    metadata: { contentType: attachment.contentType || 'application/octet-stream' }
  });
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: '03-01-2500'
  });
  return {
    nombre: safeName,
    url,
    tipo: attachment.contentType || 'application/octet-stream',
    tamaño: attachment.size || attachment.content.length,
    fecha: Date.now()
  };
}

async function pushNotification(condominioId, { titulo, mensaje, ticketId, tipo }) {
  await notificationsCol(condominioId).add({
    usuarioDestino: 'staff',
    titulo,
    mensaje,
    leida: false,
    tipo: tipo || 'email_ticket',
    ticketId: ticketId || null,
    fecha: Date.now()
  });
}

async function findTicketByNumber(condominioId, numeroTicket) {
  const q = await ticketsCol(condominioId)
    .where('numeroTicket', '==', numeroTicket)
    .limit(1)
    .get();
  if (q.empty) return null;
  const doc = q.docs[0];
  return { id: doc.id, ref: doc.ref, data: doc.data() };
}

async function findTicketByMessageId(condominioId, messageId) {
  if (!messageId) return null;
  const q = await ticketsCol(condominioId)
    .where('emailMessageId', '==', messageId)
    .limit(1)
    .get();
  if (q.empty) return null;
  const doc = q.docs[0];
  return { id: doc.id, ref: doc.ref, data: doc.data() };
}

async function processInboundEmail(condominioId, cfg, parsed, rawMeta = {}) {
  const from = parsed.from?.value?.[0] || {};
  const email = (from.address || '').toLowerCase();
  const remitente = from.name || email.split('@')[0] || 'Residente';
  const asunto = parsed.subject || '(Sin asunto)';
  const cuerpo = (parsed.text || stripHtml(parsed.html) || '').trim();
  const messageId = parsed.messageId || rawMeta.messageId || null;
  const inReplyTo = parsed.inReplyTo || rawMeta.inReplyTo || null;
  const references = parsed.references || [];

  const adjuntosMeta = [];
  const ticketRefFromSubject = extractTicketRef(asunto);

  let existing = null;
  if (ticketRefFromSubject) {
    existing = await findTicketByNumber(condominioId, ticketRefFromSubject);
  }
  if (!existing && inReplyTo) {
    existing = await findTicketByMessageId(condominioId, inReplyTo);
  }
  if (!existing && inReplyTo) {
    const q2 = await ticketsCol(condominioId).where('lastSentMessageId', '==', inReplyTo).limit(1).get();
    if (!q2.empty) {
      const doc = q2.docs[0];
      existing = { id: doc.id, ref: doc.ref, data: doc.data() };
    }
  }
  if (!existing && references.length) {
    for (const refId of references) {
      existing = await findTicketByMessageId(condominioId, refId);
      if (existing) break;
    }
  }

  const historialEntry = {
    autor: 'cliente',
    nombre: remitente,
    email,
    mensaje: cuerpo,
    fecha: Date.now(),
    adjuntos: []
  };

  if (existing) {
    const ticketId = existing.id;
    for (const att of parsed.attachments || []) {
      const meta = await uploadAttachment(condominioId, ticketId, att);
      if (meta) {
        adjuntosMeta.push(meta);
        historialEntry.adjuntos.push(meta);
      }
    }
    const historial = Array.isArray(existing.data.historial) ? existing.data.historial.slice() : [];
    historial.push(historialEntry);
    const adjuntos = (existing.data.adjuntos || []).concat(adjuntosMeta);
    await existing.ref.update({
      historial,
      adjuntos,
      fechaActualizacion: Date.now(),
      updatedAt: Date.now(),
      estado: existing.data.estado === 'Cerrado' || existing.data.estado === 'Resuelto'
        ? 'Abierto'
        : existing.data.estado
    });
    await pushNotification(condominioId, {
      titulo: 'Nueva respuesta por correo',
      mensaje: `${existing.data.numeroTicket} — ${remitente}: ${asunto}`,
      ticketId: existing.data.numeroTicket,
      tipo: 'email_reply'
    });
    return { action: 'reply', ticketId: existing.data.numeroTicket };
  }

  const numeroTicket = await nextTicketNumber(condominioId);
  const docRef = ticketsCol(condominioId).doc(numeroTicket);
  historialEntry.adjuntos = [];

  for (const att of parsed.attachments || []) {
    const meta = await uploadAttachment(condominioId, numeroTicket, att);
    if (meta) {
      adjuntosMeta.push(meta);
      historialEntry.adjuntos.push(meta);
    }
  }

  const now = Date.now();
  const ticketData = {
    id: numeroTicket,
    numeroTicket,
    origen: 'email',
    remitente,
    nombre: remitente,
    email,
    asunto,
    mensaje: cuerpo,
    descripcion: cuerpo,
    categoria: 'Consultas por correo',
    prioridad: 'Media',
    estado: 'Abierto',
    departamento: '',
    historial: [historialEntry],
    adjuntos: adjuntosMeta,
    attachments: adjuntosMeta,
    emailMessageId: messageId,
    emailThreadId: messageId,
    fechaCreacion: now,
    fechaActualizacion: now,
    createdAt: now,
    updatedAt: now,
    fecha: now
  };

  await docRef.set(ticketData);
  await pushNotification(condominioId, {
    titulo: 'Nuevo ticket por correo',
    mensaje: `${numeroTicket} — ${remitente}: ${asunto}`,
    ticketId: numeroTicket,
    tipo: 'email_ticket'
  });
  return { action: 'created', ticketId: numeroTicket };
}

async function pollCondominio(condominioId, cfg) {
  const imapCfg = imapDefaults(cfg);
  const client = new ImapFlow({
    host: imapCfg.host,
    port: imapCfg.port,
    secure: imapCfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false
  });

  const processed = [];
  const metaRef = db.doc(metaPath(condominioId));
  const metaSnap = await metaRef.get();
  let lastUid = metaSnap.exists ? (metaSnap.data().lastPollUid || 0) : 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const searchCriteria = lastUid > 0 ? { uid: `${lastUid + 1}:*` } : { seen: false };
      const messages = [];
      for await (const msg of client.fetch(searchCriteria, {
        uid: true,
        source: true,
        envelope: true
      })) {
        if (msg.uid <= lastUid) continue;
        messages.push(msg);
      }

      messages.sort((a, b) => a.uid - b.uid);

      for (const msg of messages) {
        try {
          const parsed = await simpleParser(msg.source);
          parsed.messageId = parsed.messageId || msg.envelope?.messageId;
          const result = await processInboundEmail(condominioId, cfg, parsed, {
            messageId: msg.envelope?.messageId,
            inReplyTo: parsed.inReplyTo
          });
          processed.push(result);
          lastUid = Math.max(lastUid, msg.uid);
        } catch (err) {
          console.error(`[pollEmails] parse ${condominioId} uid=${msg.uid}:`, err.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  await metaRef.set({
    lastPollUid: lastUid,
    lastPollAt: Date.now(),
    lastProcessed: processed.length
  }, { merge: true });

  return processed;
}

exports.pollInboundEmails = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'America/Santiago',
  retryCount: 1
}, async () => {
  const condosSnap = await db.collectionGroup('email_config').get();
  const results = [];

  for (const doc of condosSnap.docs) {
    const cfg = doc.data();
    if (cfg.enabled === false) continue;
    if (!cfg.smtpHost || !cfg.user || !cfg.password) continue;
    const parts = doc.ref.path.split('/');
    const condominioId = parts[1];
    try {
      const processed = await pollCondominio(condominioId, cfg);
      results.push({ condominioId, processed: processed.length });
    } catch (err) {
      console.error(`[pollInboundEmails] ${condominioId}:`, err.message);
      results.push({ condominioId, error: err.message });
    }
  }

  console.log('[pollInboundEmails] done', JSON.stringify(results));
  return results;
});

/** Callable Gen2 — CORS explícito para GitHub Pages (kike01f.github.io) */
const callableOpts = {
  region: 'us-central1',
  cors: true,
  invoker: 'public'
};

const callableLongOpts = {
  ...callableOpts,
  timeoutSeconds: 300,
  memory: '512MiB'
};

async function sendEmailTicketReplyHandler(data, auth) {
  await assertStaff(auth?.uid);
  const { condominioId, ticketId, mensaje, adminNombre } = data || {};

  if (!condominioId || !ticketId || !mensaje?.trim()) {
    fail('invalid-argument', 'Faltan datos: condominioId, ticketId, mensaje');
  }

  const cfg = await loadEmailConfig(condominioId);
  if (!cfg) fail('failed-precondition', 'Configuración de correo incompleta o desactivada');

  const ticketSnap = await ticketsCol(condominioId).doc(ticketId).get();
  if (!ticketSnap.exists) fail('not-found', 'Ticket no encontrado');

  const ticket = ticketSnap.data();
  if (ticket.origen !== 'email') {
    fail('failed-precondition', 'Este ticket no proviene de correo electrónico');
  }

  const transporter = createTransporter(cfg);
  const fromEmail = cfg.supportEmail || cfg.user;
  const numero = ticket.numeroTicket || ticketId;
  const subject = `[${numero}] Re: ${ticket.asunto || 'Consulta'}`;
  const staffName = adminNombre || 'Administración';

  const mailOptions = {
    from: `"${cfg.fromName || 'Soporte Condominio'}" <${fromEmail}>`,
    to: ticket.email,
    subject,
    text: mensaje.trim(),
    html: `<p>${mensaje.trim().replace(/\n/g, '<br>')}</p><hr><p style="color:#666;font-size:12px">Ticket ${numero} — ${cfg.buildingName || 'Condominio'}</p>`,
    inReplyTo: ticket.emailMessageId || undefined,
    references: ticket.emailThreadId || ticket.emailMessageId || undefined
  };

  const info = await transporter.sendMail(mailOptions);
  const now = Date.now();
  const entry = {
    autor: 'administrador',
    nombre: staffName,
    email: fromEmail,
    mensaje: mensaje.trim(),
    fecha: now,
    adjuntos: []
  };

  const historial = Array.isArray(ticket.historial) ? ticket.historial.slice() : [];
  historial.push(entry);

  const newEstado = ticket.estado === 'Abierto' || ticket.estado === 'En Revisión' ? 'En Proceso' : ticket.estado;

  await ticketSnap.ref.update({
    historial,
    estado: newEstado,
    fechaActualizacion: now,
    updatedAt: now,
    ultimaRespuestaAdmin: now,
    lastSentMessageId: info.messageId
  });

  return { ok: true, messageId: info.messageId, estado: newEstado };
}

async function testEmailConfigHandler(data, auth) {
  await assertStaff(auth?.uid);
  const { condominioId } = data || {};
  if (!condominioId) fail('invalid-argument', 'condominioId requerido');

  const cfg = await loadEmailConfig(condominioId);
  if (!cfg) fail('failed-precondition', 'Guarda la configuración de correo antes de probar');

  const transporter = createTransporter(cfg);
  await transporter.verify();

  const imapCfg = imapDefaults(cfg);
  const client = new ImapFlow({
    host: imapCfg.host,
    port: imapCfg.port,
    secure: imapCfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false
  });
  await client.connect();
  await client.logout();

  return { ok: true, message: 'Conexión SMTP e IMAP correcta' };
}

async function pollEmailsNowHandler(data, auth) {
  await assertStaff(auth?.uid);
  const { condominioId } = data || {};
  if (!condominioId) fail('invalid-argument', 'condominioId requerido');

  const cfg = await loadEmailConfig(condominioId);
  if (!cfg) fail('failed-precondition', 'Configuración de correo incompleta');

  const processed = await pollCondominio(condominioId, cfg);
  return { ok: true, processed: processed.length, details: processed };
}

exports.sendEmailTicketReply = onCall(callableOpts, (request) =>
  sendEmailTicketReplyHandler(request.data, request.auth)
);

exports.testEmailConfig = onCall(callableOpts, (request) =>
  testEmailConfigHandler(request.data, request.auth)
);

exports.pollEmailsNow = onCall(callableLongOpts, (request) =>
  pollEmailsNowHandler(request.data, request.auth)
);

/** Correlativo global TK-000001 — portal, chat y correo (transacción atómica) */
exports.allocateTicketNumber = onCall(callableOpts, async (request) => {
  const { condominioId } = request.data || {};
  if (!condominioId) fail('invalid-argument', 'condominioId requerido');
  const metaSnap = await db.doc(metaPath(condominioId)).get();
  const stored = metaSnap.exists ? (metaSnap.data().lastTicketNumber || 0) : 0;
  if (stored === 0) {
    await syncTicketCounterFromTickets(condominioId);
  }
  const numeroTicket = await nextTicketNumber(condominioId);
  return { numeroTicket };
});
