require('dotenv').config();

const express = require('express');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const OpenAI = require('openai');

// ====== Directorio de datos PERSISTENTE ======
// CRÍTICO: Hostinger borra el directorio del repo en cada deploy. Por eso
// guardamos la sesión de WhatsApp (auth_info) y los datos (logs) FUERA del
// repo, en el home del usuario, que sí persiste entre deploys.
// Se puede sobreescribir con la variable de entorno DATA_DIR.
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.mensajes_whatsapp_data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const AUTH_DIR = path.join(DATA_DIR, 'auth_info');
console.log(`Directorio de datos persistente: ${DATA_DIR}`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Inicializar OpenAI
let openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || ''
});

// Función para obtener configuración guardada
function getConfig() {
    try {
        const configFile = path.join(LOGS_DIR,'config.json');
        if (fs.existsSync(configFile)) {
            const data = fs.readFileSync(configFile, 'utf8');
            return JSON.parse(data);
        }
        return {};
    } catch (error) {
        console.error('Error leyendo config:', error);
        return {};
    }
}

// Función para guardar configuración
function saveConfig(config) {
    try {
        const configFile = path.join(LOGS_DIR,'config.json');
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error('Error guardando config:', error);
    }
}

// Cargar API key desde configuración guardada si no está en .env
const config = getConfig();
if (!process.env.OPENAI_API_KEY && config.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = config.OPENAI_API_KEY;
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
}

// Crear directorios necesarios si no existen
// uploads/public viven en el repo (temporales); logs/auth_info en DATA_DIR (persistente)
['uploads', 'uploads/images', 'public', LOGS_DIR, AUTH_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Configuración de multer para subir archivos
const upload = multer({ dest: 'uploads/' });
const uploadImage = multer({
    dest: 'uploads/images/',
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos de imagen'), false);
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Ruta para el dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Ruta para la página de contactos
app.get('/contacts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contacts.html'));
});

// Ruta para la página CRM
app.get('/crm', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'crm.html'));
});

// Cliente de WhatsApp (Baileys)
let sock = null;
let isClientReady = false;
let qrCodeData = null;

// Variables de control
let isInitializing = false;
let qrRetryCount = 0;
const MAX_QR_RETRIES = 5;
let initializationTimeout = null;

// Contadores de diagnóstico: cuántas veces se dispara cada evento de Baileys
const eventStats = {
    'messaging-history.set': 0,
    'chats.upsert': 0,
    'contacts.upsert': 0,
    'messages.upsert.notify': 0,
    'messages.upsert.append': 0,
    historyChats: 0,
    historyContacts: 0,
    historyMessages: 0,
    lastEvent: null,
    lastEventAt: null,
    connectedAt: null
};
function trackEvent(name, extra = {}) {
    if (eventStats[name] !== undefined) eventStats[name]++;
    eventStats.lastEvent = name;
    eventStats.lastEventAt = new Date().toISOString();
    if (extra.chats) eventStats.historyChats += extra.chats;
    if (extra.contacts) eventStats.historyContacts += extra.contacts;
    if (extra.messages) eventStats.historyMessages += extra.messages;
}

// Función para normalizar números de teléfono
const normalizePhoneNumber = (number) => {
    let cleanNumber = number.replace(/[\s\-\(\)\+]/g, '');
    if (cleanNumber.length >= 10 && /^\d+$/.test(cleanNumber)) {
        return cleanNumber;
    }
    return cleanNumber;
};

// Convertir número a JID de WhatsApp
const numberToJid = (number) => {
    const clean = normalizePhoneNumber(number);
    return clean.includes('@s.whatsapp.net') ? clean : `${clean}@s.whatsapp.net`;
};

// ====== Manejo de LID (identificador de privacidad de WhatsApp) ======
// WhatsApp usa @lid para ocultar el número real. El número real (@s.whatsapp.net)
// solo aparece en mensajes vía key.senderPn. Mantenemos un mapa LID->número.
const isPnJid = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');
const isJidGroupSafe = (jid) => typeof jid === 'string' && (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'));
const digitsOf = (jid) => {
    if (!jid || typeof jid !== 'string') return null;
    const d = jid.split('@')[0].split(':')[0].split('_')[0];
    return /^\d+$/.test(d) ? d : null;
};

let lidMapCache = null;
function getLidMap() {
    if (lidMapCache) return lidMapCache;
    try {
        const f = path.join(LOGS_DIR,'lid_map.json');
        lidMapCache = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    } catch (e) {
        lidMapCache = {};
    }
    return lidMapCache;
}
function saveLidMap() {
    try {
        fs.writeFileSync(path.join(LOGS_DIR,'lid_map.json'), JSON.stringify(lidMapCache || {}, null, 2));
    } catch (e) { /* ignorar */ }
}
let lidMapDirty = false;
function recordLidMapping(lid, pn) {
    if (!lid || !pn) return;
    const map = getLidMap();
    if (map[lid] !== pn) {
        map[lid] = pn;
        lidMapDirty = true;
    }
}

// Dado un jid de número (pn) y/o un jid lid, devuelve la identidad resuelta.
// Si solo tenemos lid pero existe mapeo, usa el número real.
function buildIdentity(pnJid, lidJid) {
    const map = getLidMap();
    let pn = isPnJid(pnJid) ? digitsOf(pnJid) : null;
    const lid = isLidJid(lidJid) ? digitsOf(lidJid) : null;

    if (pn && lid) recordLidMapping(lid, pn);
    if (!pn && lid && map[lid]) pn = map[lid];

    if (pn && pn.length >= 7) {
        return { number: pn, jid: `${pn}@s.whatsapp.net`, lid: lid || undefined, numberType: 'real' };
    }
    if (lid && lid.length >= 5) {
        return { number: lid, jid: `${lid}@lid`, lid, numberType: 'lid' };
    }
    return null;
}

// Inicializar cliente de WhatsApp con Baileys
async function initializeWhatsApp() {
    if (isInitializing) {
        console.log('Ya se está inicializando el cliente...');
        return;
    }

    if (initializationTimeout) {
        clearTimeout(initializationTimeout);
    }

    isInitializing = true;
    console.log('Inicializando cliente de WhatsApp (Baileys)...');

    initializationTimeout = setTimeout(() => {
        if (isInitializing && !isClientReady) {
            console.log('Timeout de inicialización alcanzado. Reiniciando...');
            isInitializing = false;
            if (sock) {
                sock.end(undefined);
            }
            setTimeout(() => initializeWhatsApp(), 5000);
        }
    }, 120000);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Mensajes Masivos', 'Chrome', '10.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 250,
            emitOwnEvents: true,
            syncFullHistory: true,
            markOnlineOnConnect: false,
            getMessage: async () => { return { conversation: '' }; }
        });

        // Guardar credenciales cuando se actualicen
        sock.ev.on('creds.update', saveCreds);

        // Manejar actualizaciones de conexión
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Código QR recibido
            if (qr) {
                qrRetryCount++;
                console.log(`QR Code generado (intento ${qrRetryCount}/${MAX_QR_RETRIES})`);

                if (qrRetryCount > MAX_QR_RETRIES) {
                    console.log('Máximo número de intentos de QR alcanzado. Reiniciando...');
                    sock.end(undefined);
                    isInitializing = false;
                    qrRetryCount = 0;
                    setTimeout(() => initializeWhatsApp(), 10000);
                    return;
                }

                try {
                    qrCodeData = await qrcode.toDataURL(qr);
                    io.emit('qr', qrCodeData);
                    io.emit('status', { ready: false, qrCode: qrCodeData });
                } catch (error) {
                    console.error('Error generando QR:', error);
                }
            }

            // Conexión establecida
            if (connection === 'open') {
                console.log('Cliente de WhatsApp listo!');
                isClientReady = true;
                isInitializing = false;
                qrCodeData = null;
                qrRetryCount = 0;
                eventStats.connectedAt = new Date().toISOString();

                if (initializationTimeout) {
                    clearTimeout(initializationTimeout);
                    initializationTimeout = null;
                }

                console.log('Notificando a clientes que WhatsApp está listo...');
                io.emit('ready');
                io.emit('authenticated');
                io.emit('status', { ready: true, qrCode: null });

                // Extraer contactos 30s después de conectar (da tiempo al historial sync)
                setTimeout(async () => {
                    if (isClientReady) {
                        console.log('Extracción automática de contactos post-conexión...');
                        await extractAllContactsFromWhatsApp();
                        await loadConversationHistory();
                        const contacts = getContacts();
                        console.log(`Extracción automática completada: ${contacts.length} contactos`);
                    }
                }, 30000);
            }

            // Conexión cerrada
            if (connection === 'close') {
                isClientReady = false;
                isInitializing = false;
                qrCodeData = null;

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);
                io.emit('disconnected');

                if (shouldReconnect) {
                    const delay = statusCode === 408 || statusCode === 503 ? 10000 : 5000;
                    console.log(`Reconectando en ${delay/1000} segundos...`);
                    setTimeout(() => initializeWhatsApp(), delay);
                } else {
                    console.log('Sesión cerrada. Limpiando credenciales...');
                    qrRetryCount = 0;
                    if (fs.existsSync(AUTH_DIR)) {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        fs.mkdirSync(AUTH_DIR, { recursive: true });
                    }
                    setTimeout(() => initializeWhatsApp(), 3000);
                }
            }
        });

        // Identidad a partir de una clave de mensaje (usa senderPn = número real)
        const identityFromKey = (key) => {
            if (!key) return null;
            const pnJid = isPnJid(key.senderPn) ? key.senderPn
                        : isPnJid(key.remoteJid) ? key.remoteJid
                        : isPnJid(key.participantPn) ? key.participantPn : null;
            const lidJid = isLidJid(key.senderLid) ? key.senderLid
                        : isLidJid(key.remoteJid) ? key.remoteJid
                        : isLidJid(key.participantLid) ? key.participantLid : null;
            return buildIdentity(pnJid, lidJid);
        };

        const textOf = (msg) => msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const tsOf = (msg) => msg.messageTimestamp
            ? new Date((typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp)) * 1000).toISOString()
            : new Date().toISOString();

        // Evento principal de sincronización de historial en Baileys v6
        sock.ev.on('messaging-history.set', ({ chats, contacts, messages, progress }) => {
            console.log(`Historia sincronizada: ${chats.length} chats, ${contacts.length} contactos, ${messages.length} mensajes (progreso: ${progress || '?'}%)`);
            trackEvent('messaging-history.set', { chats: chats?.length || 0, contacts: contacts?.length || 0, messages: messages?.length || 0 });
            const batch = [];

            // 1) Primero los contactos: traen lid + jid (mejor fuente para el mapa LID->número)
            for (const contact of contacts || []) {
                try {
                    if (!contact.id || contact.id.includes('@g.us')) continue;
                    const pnJid = isPnJid(contact.jid) ? contact.jid : isPnJid(contact.id) ? contact.id : null;
                    const lidJid = isLidJid(contact.lid) ? contact.lid : isLidJid(contact.id) ? contact.id : null;
                    const id = buildIdentity(pnJid, lidJid);
                    if (!id) continue;
                    const name = contact.notify || contact.verifiedName || contact.name || '';
                    batch.push({ ...id, name: name || `Usuario ${id.number.substring(0, 5)}`, lastMessage: new Date().toISOString(), isGroup: false, messageText: '' });
                } catch (e) { /* ignorar */ }
            }

            // 2) Chats
            for (const chat of chats || []) {
                try {
                    if (!chat.id || chat.id.includes('@g.us')) continue;
                    const pnJid = isPnJid(chat.id) ? chat.id : null;
                    const lidJid = isLidJid(chat.lidJid) ? chat.lidJid : isLidJid(chat.id) ? chat.id : null;
                    const id = buildIdentity(pnJid, lidJid);
                    if (!id) continue;
                    batch.push({ ...id, name: chat.name || `Usuario ${id.number.substring(0, 5)}`, lastMessage: new Date().toISOString(), isGroup: false, messageText: '' });
                } catch (e) { /* ignorar */ }
            }

            // 3) Mensajes del historial
            for (const msg of messages || []) {
                try {
                    if (msg.key?.fromMe) continue;
                    if (isJidGroupSafe(msg.key?.remoteJid)) continue;
                    const id = identityFromKey(msg.key);
                    if (!id) continue;
                    const messageText = textOf(msg);
                    batch.push({ ...id, name: msg.pushName || `Usuario ${id.number.substring(0, 5)}`, lastMessage: tsOf(msg), isGroup: false, messageText });
                    if (messageText && messageText.length > 3) saveConversation(id.number, messageText);
                } catch (e) { /* ignorar */ }
            }

            saveContactsBatch(batch);
            const totalContacts = getContacts();
            console.log(`Post-sync: ${totalContacts.length} contactos totales (${totalContacts.filter(c => c.numberType === 'real').length} con número real)`);
            io.emit('contacts-updated', { total: totalContacts.length });
        });

        // Capturar chats durante sincronización de historial
        sock.ev.on('chats.upsert', (chats) => {
            trackEvent('chats.upsert');
            const batch = [];
            for (const chat of chats) {
                try {
                    if (!chat.id || chat.id.includes('@g.us')) continue;
                    const pnJid = isPnJid(chat.id) ? chat.id : null;
                    const lidJid = isLidJid(chat.lidJid) ? chat.lidJid : isLidJid(chat.id) ? chat.id : null;
                    const id = buildIdentity(pnJid, lidJid);
                    if (!id) continue;
                    batch.push({ ...id, name: chat.name || `Usuario ${id.number.substring(0, 5)}`, lastMessage: new Date().toISOString(), isGroup: false, messageText: '' });
                } catch (e) { /* ignorar */ }
            }
            if (batch.length > 0) {
                saveContactsBatch(batch);
                console.log(`chats.upsert: ${batch.length} contactos guardados`);
            }
        });

        // Capturar nombres de contactos durante sincronización (lid + jid)
        sock.ev.on('contacts.upsert', (contacts) => {
            trackEvent('contacts.upsert');
            const batch = [];
            for (const contact of contacts) {
                try {
                    if (!contact.id || contact.id.includes('@g.us')) continue;
                    const pnJid = isPnJid(contact.jid) ? contact.jid : isPnJid(contact.id) ? contact.id : null;
                    const lidJid = isLidJid(contact.lid) ? contact.lid : isLidJid(contact.id) ? contact.id : null;
                    const id = buildIdentity(pnJid, lidJid);
                    if (!id) continue;
                    const name = contact.notify || contact.verifiedName || contact.name || '';
                    batch.push({ ...id, name: name || `Usuario ${id.number.substring(0, 5)}`, lastMessage: new Date().toISOString(), isGroup: false, messageText: '' });
                } catch (e) { /* ignorar */ }
            }
            if (batch.length > 0) {
                saveContactsBatch(batch);
                console.log(`contacts.upsert: ${batch.length} contactos actualizados`);
            }
        });

        // Capturar mensajes en tiempo real (notify) e historial (append)
        sock.ev.on('messages.upsert', async (m) => {
            try {
                trackEvent(m.type === 'append' ? 'messages.upsert.append' : 'messages.upsert.notify');
                const batch = [];
                const toLabel = [];

                for (const msg of m.messages) {
                    if (msg.key?.fromMe) continue;
                    if (isJidGroupSafe(msg.key?.remoteJid)) continue;

                    const id = identityFromKey(msg.key);
                    if (!id) continue;

                    const messageText = textOf(msg);
                    batch.push({ ...id, name: msg.pushName || `Usuario ${id.number.substring(0, 5)}`, lastMessage: tsOf(msg), isGroup: false, messageText });

                    if (messageText && messageText.length > 3) saveConversation(id.number, messageText);

                    if (m.type === 'notify' && process.env.OPENAI_API_KEY && messageText) {
                        toLabel.push({ number: id.number, text: messageText });
                    }
                }

                if (batch.length > 0) saveContactsBatch(batch);

                for (const item of toLabel) {
                    try {
                        await autoLabelContact(item.number, item.text);
                    } catch (labelError) {
                        console.log('No se pudo auto-etiquetar contacto:', labelError.message);
                    }
                }

                if (m.type === 'append' && m.messages.length > 0) {
                    console.log(`Historial sincronizado: ${m.messages.length} mensajes procesados`);
                }
            } catch (error) {
                console.error('Error procesando mensaje entrante:', error);
            }
        });

    } catch (error) {
        console.error('Error inicializando cliente:', error);
        isInitializing = false;

        if (initializationTimeout) {
            clearTimeout(initializationTimeout);
            initializationTimeout = null;
        }

        setTimeout(() => {
            console.log('Reintentando inicialización...');
            initializeWhatsApp();
        }, 15000);
    }
}

// Función para extraer contactos: ya no depende de store externo.
// Los contactos se capturan via eventos (chats.upsert, contacts.upsert, messages.upsert).
// Esta función solo reporta el estado actual.
async function extractAllContactsFromWhatsApp() {
    const contacts = getContacts();
    console.log(`Total contactos en archivo: ${contacts.length}`);
    return contacts.length;
}

// Las conversaciones se capturan en tiempo real via messages.upsert.
// Esta función reporta el estado actual.
async function loadConversationHistory() {
    try {
        const conversationsFile = path.join(LOGS_DIR,'conversations.json');
        let count = 0;
        if (fs.existsSync(conversationsFile)) {
            const data = JSON.parse(fs.readFileSync(conversationsFile, 'utf8'));
            count = Object.keys(data).length;
        }
        console.log(`Conversaciones almacenadas: ${count}`);
        return count;
    } catch (error) {
        console.error('Error verificando conversaciones:', error);
        return 0;
    }
}

// Función auxiliar para enviar mensaje de texto
async function sendTextMessage(jid, text) {
    return await sock.sendMessage(jid, { text });
}

// Función auxiliar para enviar imagen con caption
async function sendImageMessage(jid, imagePath, caption, mimetype) {
    const imageBuffer = fs.readFileSync(imagePath);
    return await sock.sendMessage(jid, {
        image: imageBuffer,
        caption: caption || '',
        mimetype: mimetype || 'image/jpeg'
    });
}

// Rutas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', async (req, res) => {
    let qr = qrCodeData;

    if (!qr && !isClientReady) {
        try {
            qr = await qrcode.toDataURL('Esperando conexión con WhatsApp...');
        } catch (err) {
            console.error('Error generando QR de estado:', err);
        }
    }

    res.json({
        ready: isClientReady,
        qrCode: qr
    });
});

app.post('/request-qr', async (req, res) => {
    try {
        if (isClientReady) {
            return res.json({ success: false, error: 'WhatsApp ya está conectado' });
        }

        const forceRestart = req.body.force || false;

        if (isInitializing && !forceRestart) {
            return res.json({
                success: false,
                error: 'Ya se está inicializando la conexión',
                canForce: true,
                message: 'Si el proceso está atascado, puedes forzar el reinicio'
            });
        }

        console.log('Solicitando nuevo código QR...');

        isInitializing = false;
        isClientReady = false;
        qrCodeData = null;
        qrRetryCount = 0;

        if (sock) {
            try {
                sock.end(undefined);
                console.log('Cliente anterior cerrado');
            } catch (error) {
                console.log('Error cerrando cliente anterior:', error.message);
            }
        }

        // Limpiar auth para forzar nuevo QR
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        setTimeout(() => initializeWhatsApp(), 1000);

        res.json({ success: true, message: 'Solicitud de QR enviada. Generando nuevo código...' });
    } catch (error) {
        console.error('Error solicitando QR:', error);
        isInitializing = false;
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

app.post('/send-message', async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({ error: 'Cliente de WhatsApp no está listo' });
    }

    const { number, message } = req.body;

    try {
        const jid = numberToJid(number);
        await sendTextMessage(jid, message);

        try {
            const contactData = {
                number: normalizePhoneNumber(number),
                name: 'Sin nombre',
                lastMessage: new Date().toISOString(),
                isGroup: false
            };
            saveContact(contactData);
        } catch (contactError) {
            console.log('No se pudo guardar contacto:', contactError.message);
        }

        res.json({ success: true, message: 'Mensaje enviado correctamente' });
    } catch (error) {
        console.error('Error enviando mensaje:', error);
        res.status(500).json({ error: 'Error enviando mensaje: ' + error.message });
    }
});

// Ruta para enviar mensajes con imagen
app.post('/send-message-with-image', uploadImage.single('image'), async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({ error: 'Cliente de WhatsApp no está listo' });
    }

    const { number, message } = req.body;
    const imageFile = req.file;

    if (!imageFile) {
        return res.status(400).json({ error: 'No se ha subido ninguna imagen' });
    }

    try {
        const jid = numberToJid(number);
        await sendImageMessage(jid, imageFile.path, message, imageFile.mimetype);

        try {
            const contactData = {
                number: normalizePhoneNumber(number),
                name: 'Sin nombre',
                lastMessage: new Date().toISOString(),
                isGroup: false
            };
            saveContact(contactData);
        } catch (contactError) {
            console.log('No se pudo guardar contacto:', contactError.message);
        }

        fs.unlinkSync(imageFile.path);
        res.json({ success: true, message: 'Mensaje con imagen enviado correctamente' });
    } catch (error) {
        console.error('Error enviando mensaje con imagen:', error);
        if (imageFile && fs.existsSync(imageFile.path)) {
            fs.unlinkSync(imageFile.path);
        }
        res.status(500).json({ error: 'Error enviando mensaje con imagen: ' + error.message });
    }
});

// Endpoint para obtener historial de campañas
app.get('/campaigns', (req, res) => {
    try {
        const campaigns = getCampaigns();
        const summary = campaigns.map(campaign => ({
            id: campaign.id,
            startTime: campaign.startTime,
            endTime: campaign.endTime,
            duration: campaign.duration,
            totalNumbers: campaign.totalNumbers,
            stats: campaign.stats,
            message: campaign.message.substring(0, 50) + (campaign.message.length > 50 ? '...' : '')
        }));
        res.json({ success: true, campaigns: summary });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo campañas: ' + error.message });
    }
});

// Endpoint para obtener detalles de una campaña específica
app.get('/campaigns/:id', (req, res) => {
    try {
        const campaignId = req.params.id;
        const logFile = path.join(LOGS_DIR,`campaign_${campaignId}.json`);

        if (!fs.existsSync(logFile)) {
            return res.status(404).json({ error: 'Campaña no encontrada' });
        }

        const data = fs.readFileSync(logFile, 'utf8');
        const campaign = JSON.parse(data);
        res.json({ success: true, campaign });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo campaña: ' + error.message });
    }
});

// Endpoint para reenviar a números fallidos
app.post('/resend-failed/:id', async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({ error: 'Cliente de WhatsApp no está listo' });
    }

    try {
        const campaignId = req.params.id;
        const { message, minDelay = 3, maxDelay = 6 } = req.body;

        const failedNumbers = getFailedNumbers(campaignId);

        if (failedNumbers.length === 0) {
            return res.json({ success: true, message: 'No hay números fallidos para reenviar' });
        }

        const minDelayMs = parseInt(minDelay) * 1000;
        const maxDelayMs = parseInt(maxDelay) * 1000;
        const results = [];
        const startTime = Date.now();
        const newCampaignId = uuidv4();

        const campaignData = {
            id: newCampaignId,
            parentCampaignId: campaignId,
            type: 'resend',
            startTime: new Date().toISOString(),
            message: message,
            totalNumbers: failedNumbers.length,
            numbers: failedNumbers,
            results: [],
            status: 'in_progress'
        };

        console.log(`Reenviando a ${failedNumbers.length} números fallidos de campaña ${campaignId}`);

        for (let i = 0; i < failedNumbers.length; i++) {
            const number = failedNumbers[i];
            try {
                const jid = numberToJid(number);
                await sendTextMessage(jid, message);

                const result = {
                    number,
                    status: 'enviado',
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);

                if (i < failedNumbers.length - 1) {
                    const delay = getRandomDelay(minDelayMs, maxDelayMs);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                console.error(`Error reenviando a ${number}:`, error);
                const result = {
                    number,
                    status: 'error',
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);
            }
        }

        campaignData.endTime = new Date().toISOString();
        campaignData.duration = Date.now() - startTime;
        campaignData.status = 'completed';
        campaignData.stats = {
            total: failedNumbers.length,
            sent: results.filter(r => r.status === 'enviado').length,
            failed: results.filter(r => r.status === 'error').length,
            successRate: ((results.filter(r => r.status === 'enviado').length / failedNumbers.length) * 100).toFixed(2)
        };

        saveCampaign(campaignData);

        res.json({
            success: true,
            results,
            campaignId: newCampaignId,
            stats: campaignData.stats
        });
    } catch (error) {
        console.error('Error en reenvío:', error);
        res.status(500).json({ error: 'Error en reenvío: ' + error.message });
    }
});

// Endpoint para obtener estadísticas generales
app.get('/stats', (req, res) => {
    try {
        const campaigns = getCampaigns();

        const stats = {
            totalCampaigns: campaigns.length,
            totalMessagesSent: campaigns.reduce((sum, c) => sum + (c.stats?.sent || 0), 0),
            totalMessagesFailed: campaigns.reduce((sum, c) => sum + (c.stats?.failed || 0), 0),
            averageSuccessRate: campaigns.length > 0 ?
                (campaigns.reduce((sum, c) => sum + parseFloat(c.stats?.successRate || 0), 0) / campaigns.length).toFixed(2) : 0,
            recentCampaigns: campaigns.slice(-5).reverse()
        };

        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo estadísticas: ' + error.message });
    }
});

// Endpoint para obtener lista de contactos
app.get('/api/contacts', (req, res) => {
    try {
        const { days } = req.query;
        const contacts = getContacts();

        let filteredContacts = contacts;

        if (days) {
            const daysAgo = new Date();
            daysAgo.setDate(daysAgo.getDate() - parseInt(days));
            filteredContacts = contacts.filter(contact =>
                new Date(contact.lastMessage) >= daysAgo
            );
        }

        const sortedContacts = filteredContacts.sort((a, b) =>
            new Date(b.lastMessage) - new Date(a.lastMessage)
        );

        res.json({
            success: true,
            contacts: sortedContacts,
            total: contacts.length,
            filtered: filteredContacts.length,
            days: days ? parseInt(days) : null
        });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo contactos: ' + error.message });
    }
});

// Endpoint para obtener contactos con etiquetas (para CRM)
app.get('/api/crm/contacts', (req, res) => {
    try {
        const { label } = req.query;
        const contacts = getContacts();
        const labels = getLabels();

        let filteredContacts = contacts.map(contact => ({
            ...contact,
            tags: labels[contact.number] || []
        }));

        if (label) {
            filteredContacts = filteredContacts.filter(contact =>
                contact.tags.includes(label)
            );
        }

        const sortedContacts = filteredContacts.sort((a, b) =>
            new Date(b.lastMessage) - new Date(a.lastMessage)
        );

        res.json({
            success: true,
            contacts: sortedContacts,
            total: contacts.length,
            filtered: filteredContacts.length,
            allLabels: getAllLabels()
        });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo CRM: ' + error.message });
    }
});

// Endpoint para obtener etiquetas de un contacto específico
app.get('/api/crm/contact/:number/labels', (req, res) => {
    try {
        const { number } = req.params;
        const labels = getLabels();
        const contactLabels = labels[number] || [];

        res.json({
            success: true,
            number,
            labels: contactLabels,
            allLabels: getAllLabels()
        });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo etiquetas: ' + error.message });
    }
});

// Endpoint para agregar etiqueta a un contacto
app.post('/api/crm/contact/:number/label', (req, res) => {
    try {
        const { number } = req.params;
        const { label } = req.body;

        if (!label) {
            return res.status(400).json({ error: 'Etiqueta requerida' });
        }

        addLabel(number, label);

        res.json({
            success: true,
            message: 'Etiqueta agregada',
            number,
            label
        });
    } catch (error) {
        res.status(500).json({ error: 'Error agregando etiqueta: ' + error.message });
    }
});

// Endpoint para eliminar etiqueta de un contacto
app.delete('/api/crm/contact/:number/label/:label', (req, res) => {
    try {
        const { number, label } = req.params;

        removeLabel(number, label);

        res.json({
            success: true,
            message: 'Etiqueta eliminada',
            number,
            label
        });
    } catch (error) {
        res.status(500).json({ error: 'Error eliminando etiqueta: ' + error.message });
    }
});

// Endpoint para obtener todas las etiquetas
app.get('/api/crm/labels', (req, res) => {
    try {
        const allLabels = getAllLabels();
        const labelStats = {};

        for (const label of allLabels) {
            const labels = getLabels();
            labelStats[label] = Object.values(labels).filter(tags => tags.includes(label)).length;
        }

        res.json({
            success: true,
            labels: allLabels,
            stats: labelStats
        });
    } catch (error) {
        res.status(500).json({ error: 'Error obteniendo etiquetas: ' + error.message });
    }
});

// Endpoint de diagnóstico: muestra qué eventos de WhatsApp han llegado
app.get('/api/debug/state', (req, res) => {
    let rawCount = 0, realCount = 0, lidCount = 0;
    try {
        const raw = getRawContacts();
        rawCount = raw.length;
        const resolved = getContacts();
        realCount = resolved.filter(c => c.numberType === 'real').length;
        lidCount = resolved.filter(c => c.numberType === 'lid').length;
    } catch (e) { /* ignorar */ }

    const lidMap = getLidMap();

    res.json({
        ready: isClientReady,
        connectedAt: eventStats.connectedAt,
        events: eventStats,
        contactsRaw: rawCount,
        contactsResueltos: realCount + lidCount,
        contactsReal: realCount,
        contactsLid: lidCount,
        lidMapSize: Object.keys(lidMap).length,
        authInfoExiste: fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0,
        dataDir: DATA_DIR,
        contactsFileExiste: fs.existsSync(path.join(LOGS_DIR,'contacts.json'))
    });
});

// Endpoint para obtener estado de API key
app.get('/api/config/openai-status', (req, res) => {
    const hasKey = !!process.env.OPENAI_API_KEY;
    res.json({
        success: true,
        configured: hasKey,
        keyPrefix: hasKey ? process.env.OPENAI_API_KEY.substring(0, 10) + '...' : null
    });
});

// Endpoint para guardar API key
app.post('/api/config/openai-key', (req, res) => {
    try {
        const { apiKey } = req.body;

        if (!apiKey || !apiKey.trim()) {
            return res.status(400).json({
                success: false,
                error: 'API key no puede estar vacía'
            });
        }

        if (!apiKey.startsWith('sk-proj-')) {
            return res.status(400).json({
                success: false,
                error: 'API key inválida. Debe comenzar con sk-proj-'
            });
        }

        // Guardar en configuración
        const config = getConfig();
        config.OPENAI_API_KEY = apiKey;
        saveConfig(config);

        // Actualizar variable de entorno
        process.env.OPENAI_API_KEY = apiKey;

        // Reinitializar OpenAI con nueva key
        openai = new OpenAI({
            apiKey: apiKey
        });

        res.json({
            success: true,
            message: 'API key configurada correctamente',
            keyPrefix: apiKey.substring(0, 10) + '...'
        });
    } catch (error) {
        console.error('Error configurando API key:', error);
        res.status(500).json({
            success: false,
            error: 'Error configurando API key: ' + error.message
        });
    }
});

// Endpoint para eliminar API key
app.post('/api/config/openai-key-remove', (req, res) => {
    try {
        const config = getConfig();
        delete config.OPENAI_API_KEY;
        saveConfig(config);

        process.env.OPENAI_API_KEY = '';
        openai = new OpenAI({
            apiKey: ''
        });

        res.json({
            success: true,
            message: 'API key eliminada'
        });
    } catch (error) {
        console.error('Error eliminando API key:', error);
        res.status(500).json({
            success: false,
            error: 'Error eliminando API key: ' + error.message
        });
    }
});

// Endpoint para cargar historial de conversaciones
app.post('/api/crm/load-history', async (req, res) => {
    if (!isClientReady || !sock) {
        return res.status(400).json({
            success: false,
            error: 'WhatsApp no está conectado'
        });
    }

    try {
        await extractAllContactsFromWhatsApp();
        await loadConversationHistory();

        const contacts = getContacts();
        res.json({
            success: true,
            message: `Historial cargado: ${contacts.length} contactos encontrados`
        });
    } catch (error) {
        console.error('Error cargando historial:', error);
        res.status(500).json({
            success: false,
            error: 'Error cargando historial: ' + error.message
        });
    }
});

// Endpoint para escanear y etiquetar todos los contactos
app.post('/api/crm/scan-messages', async (req, res) => {
    if (!process.env.OPENAI_API_KEY) {
        return res.status(400).json({
            success: false,
            error: 'OpenAI API key no configurada'
        });
    }

    try {
        const contacts = getContacts();
        const results = {
            total: contacts.length,
            processed: 0,
            labeled: 0,
            failed: 0,
            errors: []
        };

        for (const contact of contacts) {
            try {
                // Obtener el texto del mensaje, conversación histórica, o notas
                let messageText = contact.messageText || contact.notes || '';

                // Si no hay mensaje o notas, intentar obtener conversación histórica
                if (!messageText) {
                    messageText = getConversation(contact.number) || '';
                }

                if (messageText && messageText.length > 5) {
                    // Llamar a OpenAI para etiquetar
                    const response = await openai.chat.completions.create({
                        model: 'gpt-3.5-turbo',
                        messages: [
                            {
                                role: 'system',
                                content: `Eres un asistente que analiza información de clientes y asigna etiquetas automáticas.
Las etiquetas disponibles son: "Interesado", "Compró", "Pregunta", "Problema", "Seguimiento", "Otro".
Responde SOLO con una lista de etiquetas separadas por comas, sin explicación adicional.
Si no hay una etiqueta clara, responde "Otro".`
                            },
                            {
                                role: 'user',
                                content: `Analiza esta información de cliente y asigna etiquetas: "${messageText}"`
                            }
                        ],
                        max_tokens: 50,
                        temperature: 0.3
                    });

                    const labelsText = response.choices[0].message.content.trim();
                    const tagsArray = labelsText.split(',').map(tag => tag.trim()).filter(tag => tag);

                    // Limpiar etiquetas previas y agregar nuevas
                    let labels = getLabels();
                    labels[contact.number] = tagsArray;
                    saveLabels(labels);

                    results.labeled++;
                }

                results.processed++;

                // Emitir progreso via Socket.IO
                io.emit('scan-progress', {
                    current: results.processed,
                    total: results.total,
                    labeled: results.labeled,
                    contact: contact.name || contact.number
                });

            } catch (error) {
                results.failed++;
                results.errors.push({
                    number: contact.number,
                    error: error.message
                });
                console.error(`Error etiquetando ${contact.number}:`, error.message);
            }

            // Pequeña pausa para no sobrecargar OpenAI
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        res.json({
            success: true,
            results
        });
    } catch (error) {
        console.error('Error en escaneo de mensajes:', error);
        res.status(500).json({
            success: false,
            error: 'Error en escaneo: ' + error.message
        });
    }
});

// Funciones auxiliares para envío masivo
const getRandomDelay = (min, max) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

const shuffleArray = (array) => {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
};

// Ruta para enviar mensajes masivos con imagen
app.post('/send-bulk-with-image', uploadImage.fields([{ name: 'csvFile', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({ error: 'Cliente de WhatsApp no está listo' });
    }

    const {
        message,
        numbers,
        minDelay = 3,
        maxDelay = 6,
        longPauseInterval = 10,
        longPauseDelay = 30,
        randomizeOrder = false
    } = req.body;

    const imageFile = req.files && req.files.image ? req.files.image[0] : null;
    const csvFile = req.files && req.files.csvFile ? req.files.csvFile[0] : null;

    if (!imageFile) {
        return res.status(400).json({ error: 'No se ha subido ninguna imagen' });
    }

    const minDelayMs = parseInt(minDelay) * 1000;
    const maxDelayMs = parseInt(maxDelay) * 1000;
    const longPauseDelayMs = parseInt(longPauseDelay) * 1000;
    let phoneNumbers = [];

    try {
        if (csvFile) {
            const rawNumbers = await parseCSV(csvFile.path);
            phoneNumbers = rawNumbers.map(num => normalizePhoneNumber(num)).filter(num => num);
        } else if (numbers) {
            const numbersString = typeof numbers === 'string' ? numbers : String(numbers);
            phoneNumbers = numbersString.split('\n')
                .map(num => normalizePhoneNumber(num.trim()))
                .filter(num => num);
        }

        if (phoneNumbers.length === 0) {
            return res.status(400).json({ error: 'No se proporcionaron números de teléfono' });
        }

        if (randomizeOrder) {
            phoneNumbers = shuffleArray(phoneNumbers);
        }

        const results = [];
        const startTime = Date.now();
        const campaignId = uuidv4();

        const campaignData = {
            id: campaignId,
            startTime: new Date().toISOString(),
            message: message,
            totalNumbers: phoneNumbers.length,
            numbers: phoneNumbers,
            hasImage: true,
            config: { minDelay, maxDelay, longPauseInterval, longPauseDelay, randomizeOrder },
            results: [],
            status: 'in_progress'
        };

        console.log(`Iniciando campaña con imagen ${campaignId} con ${phoneNumbers.length} números`);

        for (let i = 0; i < phoneNumbers.length; i++) {
            const number = phoneNumbers[i];
            try {
                const jid = numberToJid(number);
                await sendImageMessage(jid, imageFile.path, message, imageFile.mimetype);

                const result = {
                    number,
                    status: 'enviado',
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);

                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const avgTime = elapsed / (i + 1);
                const estimatedRemaining = Math.floor(avgTime * (phoneNumbers.length - i - 1));

                io.emit('progress', {
                    current: i + 1,
                    total: phoneNumbers.length,
                    number: number,
                    elapsed: elapsed,
                    estimatedRemaining: estimatedRemaining
                });

                if (i < phoneNumbers.length - 1) {
                    if ((i + 1) % parseInt(longPauseInterval) === 0) {
                        console.log(`Pausa larga de ${longPauseDelayMs/1000} segundos después de ${i + 1} mensajes`);
                        io.emit('longPause', { current: i + 1, pauseDuration: longPauseDelayMs/1000 });
                        await new Promise(resolve => setTimeout(resolve, longPauseDelayMs));
                    } else {
                        const delay = getRandomDelay(minDelayMs, maxDelayMs);
                        console.log(`Esperando ${delay/1000} segundos antes del siguiente mensaje`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            } catch (error) {
                console.error(`Error enviando imagen a ${number}:`, error);
                const result = {
                    number,
                    status: 'error',
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);
            }
        }

        campaignData.endTime = new Date().toISOString();
        campaignData.duration = Date.now() - startTime;
        campaignData.status = 'completed';
        campaignData.stats = {
            total: phoneNumbers.length,
            sent: results.filter(r => r.status === 'enviado').length,
            failed: results.filter(r => r.status === 'error').length,
            successRate: ((results.filter(r => r.status === 'enviado').length / phoneNumbers.length) * 100).toFixed(2)
        };

        saveCampaign(campaignData);

        if (fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
        if (csvFile && fs.existsSync(csvFile.path)) fs.unlinkSync(csvFile.path);

        res.json({ success: true, results, campaignId, stats: campaignData.stats });
    } catch (error) {
        console.error('Error en campaña con imagen:', error);
        if (imageFile && fs.existsSync(imageFile.path)) fs.unlinkSync(imageFile.path);
        if (csvFile && fs.existsSync(csvFile.path)) fs.unlinkSync(csvFile.path);
        res.status(500).json({ error: 'Error en campaña con imagen: ' + error.message });
    }
});

app.post('/send-bulk', upload.single('csvFile'), async (req, res) => {
    if (!isClientReady) {
        return res.status(400).json({ error: 'Cliente de WhatsApp no está listo' });
    }

    const {
        message,
        numbers,
        minDelay = 3,
        maxDelay = 6,
        longPauseInterval = 10,
        longPauseDelay = 30,
        randomizeOrder = false
    } = req.body;

    const minDelayMs = parseInt(minDelay) * 1000;
    const maxDelayMs = parseInt(maxDelay) * 1000;
    const longPauseDelayMs = parseInt(longPauseDelay) * 1000;
    let phoneNumbers = [];

    try {
        if (req.file) {
            const rawNumbers = await parseCSV(req.file.path);
            phoneNumbers = rawNumbers.map(num => normalizePhoneNumber(num)).filter(num => num);
        } else if (numbers) {
            const numbersString = typeof numbers === 'string' ? numbers : String(numbers);
            phoneNumbers = numbersString.split('\n')
                .map(num => normalizePhoneNumber(num.trim()))
                .filter(num => num);
        }

        if (phoneNumbers.length === 0) {
            return res.status(400).json({ error: 'No se proporcionaron números de teléfono' });
        }

        if (randomizeOrder) {
            phoneNumbers = shuffleArray(phoneNumbers);
        }

        const results = [];
        const startTime = Date.now();
        const campaignId = uuidv4();

        const campaignData = {
            id: campaignId,
            startTime: new Date().toISOString(),
            message: message,
            totalNumbers: phoneNumbers.length,
            numbers: phoneNumbers,
            config: { minDelay, maxDelay, longPauseInterval, longPauseDelay, randomizeOrder },
            results: [],
            status: 'in_progress'
        };

        console.log(`Iniciando campaña ${campaignId} con ${phoneNumbers.length} números`);

        for (let i = 0; i < phoneNumbers.length; i++) {
            const number = phoneNumbers[i];
            try {
                const jid = numberToJid(number);
                await sendTextMessage(jid, message);

                const result = {
                    number,
                    status: 'enviado',
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);

                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const avgTime = elapsed / (i + 1);
                const estimatedRemaining = Math.floor(avgTime * (phoneNumbers.length - i - 1));

                io.emit('progress', {
                    current: i + 1,
                    total: phoneNumbers.length,
                    number: number,
                    elapsed: elapsed,
                    estimatedRemaining: estimatedRemaining
                });

                if (i < phoneNumbers.length - 1) {
                    if ((i + 1) % parseInt(longPauseInterval) === 0) {
                        console.log(`Pausa larga de ${longPauseDelayMs/1000} segundos después de ${i + 1} mensajes`);
                        io.emit('longPause', { current: i + 1, pauseDuration: longPauseDelayMs/1000 });
                        await new Promise(resolve => setTimeout(resolve, longPauseDelayMs));
                    } else {
                        const delay = getRandomDelay(minDelayMs, maxDelayMs);
                        console.log(`Esperando ${delay/1000} segundos antes del siguiente mensaje`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            } catch (error) {
                console.error(`Error enviando a ${number}:`, error);
                const result = {
                    number,
                    status: 'error',
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);
            }
        }

        campaignData.endTime = new Date().toISOString();
        campaignData.duration = Date.now() - startTime;
        campaignData.status = 'completed';
        campaignData.stats = {
            total: phoneNumbers.length,
            sent: results.filter(r => r.status === 'enviado').length,
            failed: results.filter(r => r.status === 'error').length,
            successRate: ((results.filter(r => r.status === 'enviado').length / phoneNumbers.length) * 100).toFixed(2)
        };

        saveCampaign(campaignData);

        if (req.file) fs.unlinkSync(req.file.path);

        res.json({ success: true, results, campaignId, stats: campaignData.stats });
    } catch (error) {
        console.error('Error en envío masivo:', error);
        res.status(500).json({ error: 'Error en envío masivo: ' + error.message });
    }
});

// Función para parsear CSV
function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const numbers = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const phoneNumber = row.telefono || row.phone || row.numero || row.number || Object.values(row)[0];
                if (phoneNumber) {
                    numbers.push(phoneNumber.toString().trim());
                }
            })
            .on('end', () => {
                resolve(numbers);
            })
            .on('error', reject);
    });
}

// Socket.IO para comunicación en tiempo real
io.on('connection', (socket) => {
    console.log('Cliente conectado - Estado actual: ready=' + isClientReady);

    socket.emit('status', {
        ready: isClientReady,
        qrCode: qrCodeData
    });

    if (isClientReady) {
        console.log('Emitiendo evento ready al cliente que se acaba de conectar');
        socket.emit('ready');
    }

    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

// Compactar y normalizar contactos existentes al arrancar (limpia sufijos @lid antiguos)
function compactContactsFile() {
    try {
        const contactsFile = path.join(LOGS_DIR,'contacts.json');
        if (!fs.existsSync(contactsFile)) return;
        const clean = getContacts(); // normaliza + deduplica
        fs.writeFileSync(contactsFile, JSON.stringify(clean, null, 2));
        const real = clean.filter(c => c.numberType === 'real').length;
        console.log(`Contactos normalizados al arrancar: ${clean.length} (${real} con número real, ${clean.length - real} solo LID)`);
    } catch (e) {
        console.error('Error compactando contactos:', e.message);
    }
}
compactContactsFile();

// Inicializar WhatsApp al arrancar el servidor
initializeWhatsApp();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});

// Cierre limpio al recibir SIGTERM (Hostinger redeploy)
const gracefulShutdown = () => {
    console.log('Cerrando servidor...');
    if (sock) {
        try { sock.end(undefined); } catch (e) { /* ignorar */ }
    }
    process.exit(0);
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Funciones de logging y seguimiento
function saveCampaign(campaignData) {
    try {
        const campaignsFile = path.join(LOGS_DIR,'campaigns.json');
        let campaigns = [];

        if (fs.existsSync(campaignsFile)) {
            const data = fs.readFileSync(campaignsFile, 'utf8');
            campaigns = JSON.parse(data);
        }

        campaigns.push(campaignData);
        fs.writeFileSync(campaignsFile, JSON.stringify(campaigns, null, 2));

        const logFile = path.join(LOGS_DIR,`campaign_${campaignData.id}.json`);
        fs.writeFileSync(logFile, JSON.stringify(campaignData, null, 2));

        console.log(`Campaña guardada: ${campaignData.id}`);
    } catch (error) {
        console.error('Error guardando campaña:', error);
    }
}

function getCampaigns() {
    try {
        const campaignsFile = path.join(LOGS_DIR,'campaigns.json');
        if (fs.existsSync(campaignsFile)) {
            const data = fs.readFileSync(campaignsFile, 'utf8');
            return JSON.parse(data);
        }
        return [];
    } catch (error) {
        console.error('Error leyendo campañas:', error);
        return [];
    }
}

function getFailedNumbers(campaignId) {
    try {
        const logFile = path.join(LOGS_DIR,`campaign_${campaignId}.json`);
        if (fs.existsSync(logFile)) {
            const data = fs.readFileSync(logFile, 'utf8');
            const campaign = JSON.parse(data);
            return campaign.results.filter(r => r.status === 'error').map(r => r.number);
        }
        return [];
    } catch (error) {
        console.error('Error obteniendo números fallidos:', error);
        return [];
    }
}

const isRealName = (n) => n && !/^Usuario \d+/.test(n) && n !== 'Sin nombre';

// Fusiona un contacto dentro de la lista en memoria (no escribe a disco)
function applyContactUpsert(contacts, contactData) {
    if (!contactData || !contactData.number) return;
    const idx = contacts.findIndex(c => c.number === contactData.number);
    if (idx >= 0) {
        const ex = contacts[idx];
        contacts[idx] = {
            ...ex,
            name: isRealName(contactData.name) ? contactData.name : (ex.name || contactData.name),
            lastMessage: contactData.lastMessage && (!ex.lastMessage || new Date(contactData.lastMessage) > new Date(ex.lastMessage))
                ? contactData.lastMessage : ex.lastMessage,
            isGroup: contactData.isGroup ?? ex.isGroup,
            messageText: contactData.messageText || ex.messageText || '',
            lid: contactData.lid || ex.lid,
            numberType: contactData.numberType === 'real' ? 'real' : (ex.numberType || contactData.numberType),
            jid: contactData.jid || ex.jid
        };
    } else {
        contacts.push({
            ...contactData,
            firstContact: contactData.firstContact || new Date().toISOString(),
            notes: contactData.notes || ''
        });
    }
}

// Guarda un solo contacto (uso en tiempo real). Parte de la lista normalizada
// para que cada escritura compacte y limpie datos antiguos.
function saveContact(contactData) {
    try {
        const contacts = getContacts();
        applyContactUpsert(contacts, contactData);
        fs.writeFileSync(path.join(LOGS_DIR,'contacts.json'), JSON.stringify(contacts, null, 2));
    } catch (error) {
        console.error('Error guardando contacto:', error);
    }
}

// Guarda muchos contactos de una vez (uso en sincronización de historial)
function saveContactsBatch(items) {
    try {
        const contacts = getContacts();
        for (const it of items) applyContactUpsert(contacts, it);
        fs.writeFileSync(path.join(LOGS_DIR,'contacts.json'), JSON.stringify(contacts, null, 2));
        if (lidMapDirty) { saveLidMap(); lidMapDirty = false; }
    } catch (error) {
        console.error('Error guardando lote de contactos:', error);
    }
}

// Endpoint para agregar notas a un contacto
app.post('/api/crm/contact/:number/notes', (req, res) => {
    try {
        const { number } = req.params;
        const { notes } = req.body;

        const contactsFile = path.join(LOGS_DIR,'contacts.json');
        let contacts = [];

        if (fs.existsSync(contactsFile)) {
            const data = fs.readFileSync(contactsFile, 'utf8');
            contacts = JSON.parse(data);
        }

        const contactIndex = contacts.findIndex(c => c.number === number);
        if (contactIndex >= 0) {
            contacts[contactIndex].notes = notes;
            fs.writeFileSync(contactsFile, JSON.stringify(contacts, null, 2));

            res.json({
                success: true,
                message: 'Notas guardadas'
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'Contacto no encontrado'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Error guardando notas: ' + error.message
        });
    }
});

function saveConversation(number, text) {
    try {
        const conversationsFile = path.join(LOGS_DIR,'conversations.json');
        let conversations = {};

        if (fs.existsSync(conversationsFile)) {
            const data = fs.readFileSync(conversationsFile, 'utf8');
            conversations = JSON.parse(data);
        }

        conversations[number] = text;
        fs.writeFileSync(conversationsFile, JSON.stringify(conversations, null, 2));
    } catch (error) {
        console.error('Error guardando conversación:', error);
    }
}

function getConversation(number) {
    try {
        const conversationsFile = path.join(LOGS_DIR,'conversations.json');
        if (!fs.existsSync(conversationsFile)) {
            return null;
        }

        const data = fs.readFileSync(conversationsFile, 'utf8');
        const conversations = JSON.parse(data);
        return conversations[number] || null;
    } catch (error) {
        console.error('Error obteniendo conversación:', error);
        return null;
    }
}

// Lee los contactos crudos del archivo (sin resolver ni deduplicar)
function getRawContacts() {
    try {
        const contactsFile = path.join(LOGS_DIR,'contacts.json');
        if (!fs.existsSync(contactsFile)) return [];
        return JSON.parse(fs.readFileSync(contactsFile, 'utf8'));
    } catch (error) {
        console.error('Error obteniendo contactos:', error);
        return [];
    }
}

// Normaliza un contacto crudo: limpia sufijos @lid/@s.whatsapp.net del número
// y resuelve el número real usando el mapa LID->número.
function normalizeContactRecord(c) {
    const map = getLidMap();
    let number = (c.number || '').toString();
    let lid = c.lid;
    let numberType = c.numberType;

    // Datos antiguos: el número puede traer el sufijo embebido
    if (number.includes('@lid')) {
        lid = lid || number.split('@')[0];
        number = number.split('@')[0];
        numberType = 'lid';
    } else if (number.includes('@s.whatsapp.net')) {
        number = number.split('@')[0];
        numberType = numberType || 'real';
    }

    // Si es un LID y ya conocemos el número real, actualizar
    if ((numberType === 'lid' || (!numberType && map[number])) && map[number]) {
        lid = number;
        number = map[number];
        numberType = 'real';
    }

    if (!numberType) {
        numberType = /^\d{7,}$/.test(number) && !lid ? 'real' : (lid ? 'lid' : 'real');
    }

    const jid = numberType === 'lid' ? `${number}@lid` : `${number}@s.whatsapp.net`;
    return { ...c, number, lid, numberType, jid };
}

// Devuelve contactos resueltos (LID->número real) y deduplicados por número.
function getContacts() {
    const raw = getRawContacts();
    const byNumber = new Map();

    for (const rc of raw) {
        const c = normalizeContactRecord(rc);
        if (!c.number) continue;

        const existing = byNumber.get(c.number);
        if (!existing) {
            byNumber.set(c.number, c);
        } else {
            // Fusionar: preferir nombre real, mensaje más reciente, conservar notas/lid
            const merged = { ...existing };
            const isRealName = (n) => n && !/^Usuario \d+/.test(n) && n !== 'Sin nombre';
            if (isRealName(c.name) && !isRealName(existing.name)) merged.name = c.name;
            if (c.lastMessage && (!existing.lastMessage || new Date(c.lastMessage) > new Date(existing.lastMessage))) {
                merged.lastMessage = c.lastMessage;
            }
            merged.messageText = existing.messageText || c.messageText || '';
            merged.notes = existing.notes || c.notes || '';
            merged.lid = existing.lid || c.lid;
            if (c.numberType === 'real') merged.numberType = 'real';
            byNumber.set(c.number, merged);
        }
    }

    return Array.from(byNumber.values());
}

// Funciones para gestión de etiquetas
function getLabels() {
    try {
        const labelsFile = path.join(LOGS_DIR,'labels.json');
        if (!fs.existsSync(labelsFile)) {
            return {};
        }

        const data = fs.readFileSync(labelsFile, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error obteniendo etiquetas:', error);
        return {};
    }
}

function saveLabels(labels) {
    try {
        const labelsFile = path.join(LOGS_DIR,'labels.json');
        fs.writeFileSync(labelsFile, JSON.stringify(labels, null, 2));
    } catch (error) {
        console.error('Error guardando etiquetas:', error);
    }
}

function addLabel(number, label) {
    const labels = getLabels();
    if (!labels[number]) {
        labels[number] = [];
    }
    if (!labels[number].includes(label)) {
        labels[number].push(label);
    }
    saveLabels(labels);
}

function removeLabel(number, label) {
    const labels = getLabels();
    if (labels[number]) {
        labels[number] = labels[number].filter(l => l !== label);
        if (labels[number].length === 0) {
            delete labels[number];
        }
    }
    saveLabels(labels);
}

function getAllLabels() {
    const labels = getLabels();
    const allLabels = new Set();
    Object.values(labels).forEach(tags => {
        tags.forEach(tag => allLabels.add(tag));
    });
    return Array.from(allLabels).sort();
}

// Función para auto-etiquetar con IA
async function autoLabelContact(number, messageText) {
    if (!messageText || messageText.length < 5) return;
    if (!process.env.OPENAI_API_KEY) return;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: `Eres un asistente que analiza mensajes de clientes y asigna etiquetas automáticas.
Las etiquetas disponibles son: "Interesado", "Compró", "Pregunta", "Problema", "Seguimiento", "Otro".
Responde SOLO con una lista de etiquetas separadas por comas, sin explicación adicional.
Si no hay una etiqueta clara, responde "Otro".`
                },
                {
                    role: 'user',
                    content: `Analiza este mensaje y asigna etiquetas: "${messageText}"`
                }
            ],
            max_tokens: 50,
            temperature: 0.3
        });

        const labelsText = response.choices[0].message.content.trim();
        const tagsArray = labelsText.split(',').map(tag => tag.trim()).filter(tag => tag);

        for (const tag of tagsArray) {
            addLabel(number, tag);
        }

        console.log(`Auto-etiquetado contacto ${number}: ${tagsArray.join(', ')}`);
    } catch (error) {
        console.error(`Error auto-etiquetando contacto ${number}:`, error.message);
    }
}
