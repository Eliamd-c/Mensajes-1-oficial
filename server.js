require('dotenv').config();

const express = require('express');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = require('baileys');
const OpenAI = require('openai');

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
        const configFile = path.join('logs', 'config.json');
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
        const configFile = path.join('logs', 'config.json');
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
['uploads', 'uploads/images', 'public', 'logs', 'auth_info'].forEach(dir => {
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

// Inicializar el store de Baileys (captura chats, contactos y mensajes)
const store = makeInMemoryStore({});
const storeFile = path.join('logs', 'baileys_store.json');
try { store.readFromFile(storeFile); } catch (e) { /* primera vez, no existe */ }
setInterval(() => {
    try { store.writeToFile(storeFile); } catch (e) { /* ignorar */ }
}, 30000);

// Variables de control
let isInitializing = false;
let qrRetryCount = 0;
const MAX_QR_RETRIES = 5;
let initializationTimeout = null;

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
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
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
            getMessage: async (key) => {
                const jid = key.remoteJid;
                const msg = store.messages?.[jid]?.get(key.id);
                return msg?.message || { conversation: '' };
            }
        });

        // Vincular store al socket para capturar TODOS los eventos
        store.bind(sock.ev);

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

                // Guardar store antes de reconectar
                try { store.writeToFile(storeFile); } catch (e) { /* ignorar */ }

                if (shouldReconnect) {
                    const delay = statusCode === 408 || statusCode === 503 ? 10000 : 5000;
                    console.log(`Reconectando en ${delay/1000} segundos...`);
                    setTimeout(() => initializeWhatsApp(), delay);
                } else {
                    console.log('Sesión cerrada. Limpiando credenciales...');
                    qrRetryCount = 0;
                    if (fs.existsSync('auth_info')) {
                        fs.rmSync('auth_info', { recursive: true, force: true });
                        fs.mkdirSync('auth_info', { recursive: true });
                    }
                    setTimeout(() => initializeWhatsApp(), 3000);
                }
            }
        });

        // Capturar chats durante sincronización de historial
        sock.ev.on('chats.upsert', (chats) => {
            let added = 0;
            for (const chat of chats) {
                try {
                    if (!chat.id || chat.id.includes('@g.us')) continue;
                    const number = chat.id.replace('@s.whatsapp.net', '');
                    if (!number || number.length < 5) continue;

                    const contactData = {
                        number,
                        name: chat.name || `Usuario ${number.substring(0, 5)}`,
                        lastMessage: new Date().toISOString(),
                        isGroup: false,
                        messageText: ''
                    };
                    saveContact(contactData);
                    added++;
                } catch (e) { /* ignorar chat individual con error */ }
            }
            if (added > 0) console.log(`chats.upsert: ${added} contactos guardados de ${chats.length} chats`);
        });

        // Capturar nombres de contactos durante sincronización
        sock.ev.on('contacts.upsert', (contacts) => {
            let updated = 0;
            for (const contact of contacts) {
                try {
                    if (!contact.id || contact.id.includes('@g.us')) continue;
                    const number = contact.id.replace('@s.whatsapp.net', '');
                    if (!number || number.length < 5) continue;

                    const name = contact.notify || contact.verifiedName || contact.name || '';
                    if (name) {
                        const contactData = {
                            number,
                            name,
                            lastMessage: new Date().toISOString(),
                            isGroup: false,
                            messageText: ''
                        };
                        saveContact(contactData);
                        updated++;
                    }
                } catch (e) { /* ignorar contacto individual con error */ }
            }
            if (updated > 0) console.log(`contacts.upsert: ${updated} nombres actualizados`);
        });

        // Capturar mensajes: tanto nuevos (notify) como historial (append)
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const isHistorySync = m.type === 'append';

                for (const msg of m.messages) {
                    if (!msg.key.remoteJid?.endsWith('@s.whatsapp.net')) continue;
                    if (msg.key.fromMe) continue;

                    const number = msg.key.remoteJid.replace('@s.whatsapp.net', '');
                    const pushName = msg.pushName || 'Sin nombre';
                    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

                    const timestamp = msg.messageTimestamp
                        ? new Date(typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp * 1000 : Number(msg.messageTimestamp) * 1000).toISOString()
                        : new Date().toISOString();

                    const contactData = {
                        number,
                        name: pushName,
                        lastMessage: timestamp,
                        isGroup: false,
                        messageText: messageText
                    };

                    saveContact(contactData);

                    if (messageText && messageText.length > 3) {
                        saveConversation(number, messageText);
                    }

                    // Auto-etiquetar solo mensajes nuevos en tiempo real (no historial)
                    if (m.type === 'notify' && process.env.OPENAI_API_KEY && messageText) {
                        try {
                            await autoLabelContact(number, messageText);
                        } catch (labelError) {
                            console.log('No se pudo auto-etiquetar contacto:', labelError.message);
                        }
                    }
                }

                if (isHistorySync && m.messages.length > 0) {
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

// Función para extraer TODOS los contactos de WhatsApp usando el store
async function extractAllContactsFromWhatsApp() {
    try {
        console.log('Extrayendo contactos del store de Baileys...');

        let allChats = [];
        try {
            if (store.chats) {
                if (typeof store.chats.all === 'function') {
                    allChats = store.chats.all();
                } else if (store.chats instanceof Map) {
                    allChats = Array.from(store.chats.values());
                } else if (typeof store.chats.toJSON === 'function') {
                    allChats = store.chats.toJSON();
                } else if (Array.isArray(store.chats)) {
                    allChats = store.chats;
                }
            }
        } catch (error) {
            console.warn('No se pudieron obtener los chats del store:', error.message);
        }

        console.log(`Store contiene ${allChats.length} chats`);

        let newContactsAdded = 0;

        for (const chat of allChats) {
            try {
                if (!chat || !chat.id) continue;
                if (chat.id.includes('@g.us')) continue;

                const number = chat.id.replace('@s.whatsapp.net', '');
                if (!number || number.length < 5) continue;

                let lastMessage = new Date().toISOString();
                let messageText = '';

                try {
                    const msgStore = store.messages?.[chat.id];
                    if (msgStore) {
                        let messages = [];
                        if (typeof msgStore.all === 'function') {
                            messages = msgStore.all();
                        } else if (msgStore instanceof Map) {
                            messages = Array.from(msgStore.values());
                        } else if (typeof msgStore.toJSON === 'function') {
                            messages = msgStore.toJSON();
                        }

                        if (messages.length > 0) {
                            const lastMsg = messages[messages.length - 1];
                            if (lastMsg?.messageTimestamp) {
                                const ts = typeof lastMsg.messageTimestamp === 'number'
                                    ? lastMsg.messageTimestamp : Number(lastMsg.messageTimestamp);
                                lastMessage = new Date(ts * 1000).toISOString();
                            }
                            messageText = lastMsg?.message?.conversation ||
                                         lastMsg?.message?.extendedTextMessage?.text || '';
                        }
                    }
                } catch (e) { /* no hay mensajes */ }

                const name = chat.name || store.contacts?.[chat.id]?.notify || `Usuario ${number.substring(0, 5)}`;

                const contactData = {
                    number,
                    name,
                    lastMessage,
                    firstContact: lastMessage,
                    isGroup: false,
                    messageText,
                    notes: ''
                };

                saveContact(contactData);
                newContactsAdded++;
            } catch (error) {
                console.error('Error procesando chat:', error.message);
            }
        }

        console.log(`Extracción completada: ${newContactsAdded} contactos procesados de ${allChats.length} chats`);
    } catch (error) {
        console.error('Error extrayendo contactos:', error);
    }
}

// Función para cargar historial de conversaciones desde el store
async function loadConversationHistory() {
    try {
        console.log('Cargando historial de conversaciones desde store...');

        let allChats = [];
        try {
            if (store.chats) {
                if (typeof store.chats.all === 'function') {
                    allChats = store.chats.all();
                } else if (store.chats instanceof Map) {
                    allChats = Array.from(store.chats.values());
                } else if (typeof store.chats.toJSON === 'function') {
                    allChats = store.chats.toJSON();
                } else if (Array.isArray(store.chats)) {
                    allChats = store.chats;
                }
            }
        } catch (error) {
            console.warn('No se pudieron obtener los chats del store:', error.message);
            return;
        }

        console.log(`Procesando historial de ${allChats.length} chats...`);
        let processedContacts = 0;

        for (const chat of allChats) {
            try {
                if (!chat || !chat.id) continue;
                if (chat.id.includes('@g.us')) continue;

                const number = chat.id.replace('@s.whatsapp.net', '');
                if (!number || number.length < 5) continue;

                let messages = [];
                try {
                    const msgStore = store.messages?.[chat.id];
                    if (msgStore) {
                        if (typeof msgStore.all === 'function') {
                            messages = msgStore.all();
                        } else if (msgStore instanceof Map) {
                            messages = Array.from(msgStore.values());
                        } else if (typeof msgStore.toJSON === 'function') {
                            messages = msgStore.toJSON();
                        }
                    }
                } catch (e) { /* no hay mensajes */ }

                if (messages.length > 0) {
                    const incomingMessages = messages
                        .filter(msg => msg?.key && !msg.key.fromMe && msg.message)
                        .slice(-10);

                    if (incomingMessages.length > 0) {
                        const texts = incomingMessages
                            .map(msg => msg.message?.conversation || msg.message?.extendedTextMessage?.text || '')
                            .filter(text => text.length > 0)
                            .join(' | ');

                        if (texts.length > 5) {
                            saveConversation(number, texts);
                            processedContacts++;
                        }
                    }
                }
            } catch (error) {
                console.error('Error procesando chat:', error.message);
            }
        }

        console.log(`Historial cargado: ${processedContacts} contactos con conversaciones`);
    } catch (error) {
        console.error('Error cargando conversaciones:', error);
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
        if (fs.existsSync('auth_info')) {
            fs.rmSync('auth_info', { recursive: true, force: true });
            fs.mkdirSync('auth_info', { recursive: true });
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
        const logFile = path.join('logs', `campaign_${campaignId}.json`);

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

// Inicializar WhatsApp al arrancar el servidor
initializeWhatsApp();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});

// Guardar store al cerrar el proceso (Hostinger redeploy)
const gracefulShutdown = () => {
    console.log('Cerrando servidor, guardando store...');
    try { store.writeToFile(storeFile); } catch (e) { /* ignorar */ }
    process.exit(0);
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Funciones de logging y seguimiento
function saveCampaign(campaignData) {
    try {
        const campaignsFile = path.join('logs', 'campaigns.json');
        let campaigns = [];

        if (fs.existsSync(campaignsFile)) {
            const data = fs.readFileSync(campaignsFile, 'utf8');
            campaigns = JSON.parse(data);
        }

        campaigns.push(campaignData);
        fs.writeFileSync(campaignsFile, JSON.stringify(campaigns, null, 2));

        const logFile = path.join('logs', `campaign_${campaignData.id}.json`);
        fs.writeFileSync(logFile, JSON.stringify(campaignData, null, 2));

        console.log(`Campaña guardada: ${campaignData.id}`);
    } catch (error) {
        console.error('Error guardando campaña:', error);
    }
}

function getCampaigns() {
    try {
        const campaignsFile = path.join('logs', 'campaigns.json');
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
        const logFile = path.join('logs', `campaign_${campaignId}.json`);
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

function saveContact(contactData) {
    try {
        const contactsFile = path.join('logs', 'contacts.json');
        let contacts = [];

        if (fs.existsSync(contactsFile)) {
            const data = fs.readFileSync(contactsFile, 'utf8');
            contacts = JSON.parse(data);
        }

        const existingIndex = contacts.findIndex(c => c.number === contactData.number);

        if (existingIndex >= 0) {
            contacts[existingIndex] = {
                ...contacts[existingIndex],
                name: contactData.name,
                lastMessage: contactData.lastMessage,
                isGroup: contactData.isGroup,
                messageText: contactData.messageText || contacts[existingIndex].messageText || ''
            };
        } else {
            contacts.push({
                ...contactData,
                firstContact: contactData.firstContact || new Date().toISOString(),
                notes: contactData.notes || ''
            });
        }

        fs.writeFileSync(contactsFile, JSON.stringify(contacts, null, 2));
    } catch (error) {
        console.error('Error guardando contacto:', error);
    }
}

// Endpoint para agregar notas a un contacto
app.post('/api/crm/contact/:number/notes', (req, res) => {
    try {
        const { number } = req.params;
        const { notes } = req.body;

        const contactsFile = path.join('logs', 'contacts.json');
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
        const conversationsFile = path.join('logs', 'conversations.json');
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
        const conversationsFile = path.join('logs', 'conversations.json');
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

function getContacts() {
    try {
        const contactsFile = path.join('logs', 'contacts.json');
        if (!fs.existsSync(contactsFile)) {
            return [];
        }

        const data = fs.readFileSync(contactsFile, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error obteniendo contactos:', error);
        return [];
    }
}

// Funciones para gestión de etiquetas
function getLabels() {
    try {
        const labelsFile = path.join('logs', 'labels.json');
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
        const labelsFile = path.join('logs', 'labels.json');
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
