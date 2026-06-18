const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuración de multer para subir archivos
const upload = multer({ dest: 'uploads/' });
const uploadImage = multer({ 
    dest: 'uploads/images/',
    fileFilter: (req, file, cb) => {
        // Permitir solo imágenes
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos de imagen'), false);
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB máximo
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

// Cliente de WhatsApp
let client;
let isClientReady = false;
let qrCodeData = null;

// Variables de control
let isInitializing = false;
let qrRetryCount = 0;
const MAX_QR_RETRIES = 3;
let initializationTimeout = null;

// Inicializar cliente de WhatsApp
function initializeWhatsApp() {
    if (isInitializing) {
        console.log('Ya se está inicializando el cliente...');
        return;
    }

    // Limpiar timeout anterior si existe
    if (initializationTimeout) {
        clearTimeout(initializationTimeout);
    }

    isInitializing = true;
    console.log('Inicializando cliente de WhatsApp...');
    console.log('Nota: Si hay problemas con Puppeteer, intenta: npm install --save-dev @vscode/sqlite3');
    
    // Timeout de seguridad para evitar que se quede colgado
    initializationTimeout = setTimeout(() => {
        if (isInitializing && !isClientReady) {
            console.log('Timeout de inicialización alcanzado. Reiniciando proceso...');
            isInitializing = false;
            if (client) {
                client.destroy().catch(() => {});
            }
            setTimeout(() => {
                initializeWhatsApp();
            }, 5000);
        }
    }, 120000); // 2 minutos de timeout
    
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "whatsapp-bulk",
            dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ],
            timeout: 60000
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    client.on('qr', async (qr) => {
        qrRetryCount++;
        console.log(`QR Code generado (intento ${qrRetryCount}/${MAX_QR_RETRIES})`);
        
        if (qrRetryCount > MAX_QR_RETRIES) {
            console.log('Máximo número de intentos de QR alcanzado. Reiniciando...');
            client.destroy();
            isInitializing = false;
            qrRetryCount = 0;
            setTimeout(() => {
                initializeWhatsApp();
            }, 10000);
            return;
        }
        
        try {
            qrCodeData = await qrcode.toDataURL(qr);
            io.emit('qr', qrCodeData);
        } catch (error) {
            console.error('Error generando QR:', error);
        }
    });

    client.on('ready', async () => {
        console.log('Cliente de WhatsApp listo!');
        isClientReady = true;
        isInitializing = false;
        qrCodeData = null;
        qrRetryCount = 0;

        // Limpiar timeout de inicialización
        if (initializationTimeout) {
            clearTimeout(initializationTimeout);
            initializationTimeout = null;
        }

        // Emitir a todos los clientes conectados
        console.log('Notificando a clientes que WhatsApp está listo...');
        io.emit('ready');
        io.emit('status', {
            ready: true,
            qrCode: null
        });
        
        // Cargar todos los chats existentes para obtener el historial de contactos
        try {
            console.log('Cargando historial de chats...');
            const chats = await client.getChats();
            console.log(`Encontrados ${chats.length} chats`);
            
            for (const chat of chats) {
                if (!chat.isGroup) { // Solo contactos individuales
                    try {
                        const contact = await chat.getContact();
                        const contactData = {
                            number: contact.number,
                            name: contact.pushname || contact.name || 'Sin nombre',
                            lastMessage: chat.lastMessage ? new Date(chat.lastMessage.timestamp * 1000).toISOString() : new Date().toISOString(),
                            firstContact: new Date().toISOString(), // Se actualizará si ya existe
                            isGroup: false
                        };
                        saveContact(contactData);
                    } catch (contactError) {
                        console.log('Error obteniendo contacto del chat:', contactError.message);
                    }
                }
            }
            console.log('Historial de contactos cargado exitosamente');
        } catch (error) {
            console.error('Error cargando historial de chats:', error);
        }
    });

    client.on('authenticated', () => {
        console.log('Autenticado correctamente');
        isInitializing = false;
        qrRetryCount = 0;

        // Si se autenticó correctamente, después de un pequeño delay, marcar como listo
        setTimeout(() => {
            if (!isClientReady) {
                console.log('Marcando cliente como listo después de autenticación...');
                isClientReady = true;
                qrCodeData = null;
                io.emit('ready');
                io.emit('status', {
                    ready: true,
                    qrCode: null
                });
            }
        }, 2000);

        io.emit('authenticated');
    });

    client.on('disconnected', (reason) => {
        console.log('Cliente desconectado:', reason);
        isClientReady = false;
        isInitializing = false;
        qrCodeData = null;
        qrRetryCount = 0;
        io.emit('disconnected');
        
        // Solo reconectar si no fue una desconexión intencional
        if (reason !== 'NAVIGATION' && reason !== 'LOGOUT') {
            console.log('Esperando 15 segundos antes de reconectar...');
            setTimeout(() => {
                if (!isClientReady && !isInitializing) {
                    console.log('Intentando reconectar...');
                    initializeWhatsApp();
                }
            }, 15000);
        }
    });

    client.on('auth_failure', (msg) => {
        console.error('Fallo de autenticación:', msg);
        isClientReady = false;
        isInitializing = false;
        qrCodeData = null;
        qrRetryCount = 0;
        
        // Limpiar timeout de inicialización
        if (initializationTimeout) {
            clearTimeout(initializationTimeout);
            initializationTimeout = null;
        }
        
        io.emit('auth_failure', msg);
    });

    // Evento para capturar mensajes entrantes y almacenar contactos
    client.on('message', async (message) => {
        try {
            // Solo procesar mensajes de contactos individuales (no grupos)
            if (message.from.includes('@c.us')) {
                const contact = await message.getContact();
                const contactData = {
                    number: message.from.replace('@c.us', ''),
                    name: contact.pushname || contact.name || 'Sin nombre',
                    lastMessage: new Date().toISOString(),
                    isGroup: false
                };
                
                saveContact(contactData);
            }
        } catch (error) {
            console.error('Error procesando mensaje entrante:', error);
        }
    });

    client.initialize().catch(error => {
        console.error('Error inicializando cliente:', error);
        isInitializing = false;
        
        // Limpiar timeout de inicialización
        if (initializationTimeout) {
            clearTimeout(initializationTimeout);
            initializationTimeout = null;
        }
        
        setTimeout(() => {
            console.log('Reintentando inicialización...');
            initializeWhatsApp();
        }, 15000);
    });
}

// Rutas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', async (req, res) => {
    // Si no hay QR disponible y no está listo, generar uno de prueba
    let qr = qrCodeData;

    if (!qr && !isClientReady) {
        try {
            // Generar un QR de prueba con instrucciones
            qr = await qrcode.toDataURL('Escanea este código QR con WhatsApp Web para conectar. Si tienes problemas, recarga la página.');
        } catch (err) {
            console.error('Error generando QR de prueba:', err);
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
        
        // Permitir forzar reinicialización si está atascado
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
        
        // Limpiar estado anterior
        isInitializing = false;
        isClientReady = false;
        qrCodeData = null;
        qrRetryCount = 0;
        
        // Destruir cliente existente si existe
        if (client) {
            try {
                await client.destroy();
                console.log('Cliente anterior destruido');
            } catch (error) {
                console.log('Error destruyendo cliente anterior:', error.message);
            }
        }
        
        // Esperar un momento antes de reinicializar
        setTimeout(() => {
            initializeWhatsApp();
        }, 1000);
        
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
    
    // Función para normalizar números de teléfono
    const normalizePhoneNumber = (number) => {
        // Remover espacios, guiones y otros caracteres
        let cleanNumber = number.replace(/[\s\-\(\)\+]/g, '');
        
        // Si el número ya tiene formato internacional (empieza con código de país)
        if (cleanNumber.length >= 10 && /^\d+$/.test(cleanNumber)) {
            return cleanNumber;
        }
        
        return cleanNumber;
    };
    
    try {
        const normalizedNumber = normalizePhoneNumber(number);
        const chatId = normalizedNumber.includes('@c.us') ? normalizedNumber : `${normalizedNumber}@c.us`;
        await client.sendMessage(chatId, message);
        
        // Registrar contacto
        try {
            const contact = await client.getContactById(chatId);
            const contactData = {
                number: normalizedNumber,
                name: contact.pushname || contact.name || 'Sin nombre',
                lastMessage: new Date().toISOString(),
                isGroup: false
            };
            saveContact(contactData);
        } catch (contactError) {
            console.log('No se pudo obtener información del contacto:', contactError.message);
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
    
    // Función para normalizar números de teléfono
    const normalizePhoneNumber = (number) => {
        // Remover espacios, guiones y otros caracteres
        let cleanNumber = number.replace(/[\s\-\(\)\+]/g, '');
        
        // Si el número ya tiene formato internacional (empieza con código de país)
        if (cleanNumber.length >= 10 && /^\d+$/.test(cleanNumber)) {
            return cleanNumber;
        }
        
        return cleanNumber;
    };
    
    try {
        const normalizedNumber = normalizePhoneNumber(number);
        const chatId = normalizedNumber.includes('@c.us') ? normalizedNumber : `${normalizedNumber}@c.us`;
        
        // Crear el objeto MessageMedia desde el archivo de imagen
        const media = MessageMedia.fromFilePath(imageFile.path);
        
        // Forzar el tipo MIME para asegurar que se envíe como imagen
        media.mimetype = imageFile.mimetype;
        
        // Enviar la imagen con el mensaje como caption
        await client.sendMessage(chatId, media, { caption: message || '' });
        
        // Registrar contacto
        try {
            const contact = await client.getContactById(chatId);
            const contactData = {
                number: normalizedNumber,
                name: contact.pushname || contact.name || 'Sin nombre',
                lastMessage: new Date().toISOString(),
                isGroup: false
            };
            saveContact(contactData);
        } catch (contactError) {
            console.log('No se pudo obtener información del contacto:', contactError.message);
        }
        
        // Eliminar el archivo temporal después de enviarlo
        fs.unlinkSync(imageFile.path);
        
        res.json({ success: true, message: 'Mensaje con imagen enviado correctamente' });
    } catch (error) {
        console.error('Error enviando mensaje con imagen:', error);
        
        // Eliminar el archivo temporal en caso de error
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
        
        // Crear nueva campaña para el reenvío
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
                const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
                await client.sendMessage(chatId, message);
                
                const result = {
                    number,
                    status: 'enviado',
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);
                
                // Pausa entre mensajes
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
        
        // Finalizar campaña de reenvío
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
        
        // Filtrar por días si se especifica
        if (days) {
            const daysAgo = new Date();
            daysAgo.setDate(daysAgo.getDate() - parseInt(days));
            
            filteredContacts = contacts.filter(contact => 
                new Date(contact.lastMessage) >= daysAgo
            );
        }
        
        // Ordenar por último mensaje (más reciente primero)
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
    
    // Convertir segundos a milisegundos
    const minDelayMs = parseInt(minDelay) * 1000;
    const maxDelayMs = parseInt(maxDelay) * 1000;
    const longPauseDelayMs = parseInt(longPauseDelay) * 1000;
    let phoneNumbers = [];
    
    // Función para generar delay aleatorio
    const getRandomDelay = (min, max) => {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };
    
    // Función para mezclar array aleatoriamente
    const shuffleArray = (array) => {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    };
    
    // Función para normalizar números de teléfono
    const normalizePhoneNumber = (number) => {
        // Remover espacios, guiones y otros caracteres
        let cleanNumber = number.replace(/[\s\-\(\)\+]/g, '');
        
        // Si el número ya tiene formato internacional (empieza con código de país)
        if (cleanNumber.length >= 10 && /^\d+$/.test(cleanNumber)) {
            return cleanNumber;
        }
        
        return cleanNumber;
    };

    try {
        // Si se subió un archivo CSV
        if (csvFile) {
            const rawNumbers = await parseCSV(csvFile.path);
            phoneNumbers = rawNumbers.map(num => normalizePhoneNumber(num)).filter(num => num);
        } else if (numbers) {
            // Si se proporcionaron números directamente
            // Asegurar que numbers sea una cadena de texto
            const numbersString = typeof numbers === 'string' ? numbers : String(numbers);
            phoneNumbers = numbersString.split('\n')
                .map(num => normalizePhoneNumber(num.trim()))
                .filter(num => num);
        }

        if (phoneNumbers.length === 0) {
            return res.status(400).json({ error: 'No se proporcionaron números de teléfono' });
        }

        // Mezclar orden si está habilitado
        if (randomizeOrder) {
            phoneNumbers = shuffleArray(phoneNumbers);
        }

        const results = [];
        const startTime = Date.now();
        const campaignId = uuidv4();
        
        // Crear el objeto MessageMedia desde el archivo subido
        const media = MessageMedia.fromFilePath(imageFile.path);
        
        // Forzar el tipo MIME para asegurar que se envíe como imagen
        media.mimetype = imageFile.mimetype;
        
        // Crear objeto de campaña
        const campaignData = {
            id: campaignId,
            startTime: new Date().toISOString(),
            message: message,
            totalNumbers: phoneNumbers.length,
            numbers: phoneNumbers,
            hasImage: true,
            config: {
                minDelay,
                maxDelay,
                longPauseInterval,
                longPauseDelay,
                randomizeOrder
            },
            results: [],
            status: 'in_progress'
        };
        
        console.log(`Iniciando campaña con imagen ${campaignId} con ${phoneNumbers.length} números`);
        
        for (let i = 0; i < phoneNumbers.length; i++) {
            const number = phoneNumbers[i];
            try {
                const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
                await client.sendMessage(chatId, media, { caption: message || '' });
                const result = { 
                    number, 
                    status: 'enviado', 
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);
                
                // Emitir progreso con información adicional
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
                
                // No hacer pausa después del último mensaje
                if (i < phoneNumbers.length - 1) {
                    // Pausa larga cada X mensajes
                    if ((i + 1) % parseInt(longPauseInterval) === 0) {
                        console.log(`Pausa larga de ${longPauseDelayMs/1000} segundos después de ${i + 1} mensajes`);
                        io.emit('longPause', {
                            current: i + 1,
                            pauseDuration: longPauseDelayMs/1000
                        });
                        await new Promise(resolve => setTimeout(resolve, longPauseDelayMs));
                    } else {
                        // Pausa aleatoria normal
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
        
        // Finalizar campaña
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
        
        // Eliminar el archivo temporal de imagen después de la campaña
        if (fs.existsSync(imageFile.path)) {
            fs.unlinkSync(imageFile.path);
        }
        
        // Eliminar archivo CSV temporal si existe
        if (csvFile && fs.existsSync(csvFile.path)) {
            fs.unlinkSync(csvFile.path);
        }
        
        res.json({
            success: true,
            results,
            campaignId,
            stats: campaignData.stats
        });
    } catch (error) {
        console.error('Error en campaña con imagen:', error);
        
        // Limpiar archivos temporales en caso de error
        if (imageFile && fs.existsSync(imageFile.path)) {
            fs.unlinkSync(imageFile.path);
        }
        if (csvFile && fs.existsSync(csvFile.path)) {
            fs.unlinkSync(csvFile.path);
        }
        
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
    
    // Convertir segundos a milisegundos
    const minDelayMs = parseInt(minDelay) * 1000;
    const maxDelayMs = parseInt(maxDelay) * 1000;
    const longPauseDelayMs = parseInt(longPauseDelay) * 1000;
    let phoneNumbers = [];
    
    // Función para generar delay aleatorio
    const getRandomDelay = (min, max) => {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };
    
    // Función para mezclar array aleatoriamente
    const shuffleArray = (array) => {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    };
    
    // Función para normalizar números de teléfono
    const normalizePhoneNumber = (number) => {
        // Remover espacios, guiones y otros caracteres
        let cleanNumber = number.replace(/[\s\-\(\)\+]/g, '');
        
        // Si el número ya tiene formato internacional (empieza con código de país)
        if (cleanNumber.length >= 10 && /^\d+$/.test(cleanNumber)) {
            return cleanNumber;
        }
        
        return cleanNumber;
    };

    try {
        // Si se subió un archivo CSV
        if (req.file) {
            const rawNumbers = await parseCSV(req.file.path);
            phoneNumbers = rawNumbers.map(num => normalizePhoneNumber(num)).filter(num => num);
        } else if (numbers) {
            // Si se proporcionaron números directamente
            // Asegurar que numbers sea una cadena de texto
            const numbersString = typeof numbers === 'string' ? numbers : String(numbers);
            phoneNumbers = numbersString.split('\n')
                .map(num => normalizePhoneNumber(num.trim()))
                .filter(num => num);
        }

        if (phoneNumbers.length === 0) {
            return res.status(400).json({ error: 'No se proporcionaron números de teléfono' });
        }

        // Mezclar orden si está habilitado
        if (randomizeOrder) {
            phoneNumbers = shuffleArray(phoneNumbers);
        }

        const results = [];
        const startTime = Date.now();
        const campaignId = uuidv4();
        
        // Crear objeto de campaña
        const campaignData = {
            id: campaignId,
            startTime: new Date().toISOString(),
            message: message,
            totalNumbers: phoneNumbers.length,
            numbers: phoneNumbers,
            config: {
                minDelay,
                maxDelay,
                longPauseInterval,
                longPauseDelay,
                randomizeOrder
            },
            results: [],
            status: 'in_progress'
        };
        
        console.log(`Iniciando campaña ${campaignId} con ${phoneNumbers.length} números`);
        
        for (let i = 0; i < phoneNumbers.length; i++) {
            const number = phoneNumbers[i];
            try {
                const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
                await client.sendMessage(chatId, message);
                const result = { 
                    number, 
                    status: 'enviado', 
                    timestamp: new Date().toISOString(),
                    index: i + 1
                };
                results.push(result);
                campaignData.results.push(result);
                
                // Emitir progreso con información adicional
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
                
                // No hacer pausa después del último mensaje
                if (i < phoneNumbers.length - 1) {
                    // Pausa larga cada X mensajes
                    if ((i + 1) % parseInt(longPauseInterval) === 0) {
                        console.log(`Pausa larga de ${longPauseDelayMs/1000} segundos después de ${i + 1} mensajes`);
                        io.emit('longPause', {
                            current: i + 1,
                            pauseDuration: longPauseDelayMs/1000
                        });
                        await new Promise(resolve => setTimeout(resolve, longPauseDelayMs));
                    } else {
                        // Pausa aleatoria normal
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

        // Finalizar campaña
        campaignData.endTime = new Date().toISOString();
        campaignData.duration = Date.now() - startTime;
        campaignData.status = 'completed';
        campaignData.stats = {
            total: phoneNumbers.length,
            sent: results.filter(r => r.status === 'enviado').length,
            failed: results.filter(r => r.status === 'error').length,
            successRate: ((results.filter(r => r.status === 'enviado').length / phoneNumbers.length) * 100).toFixed(2)
        };
        
        // Guardar campaña
        saveCampaign(campaignData);
        
        // Limpiar archivo temporal
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }

        res.json({ 
            success: true, 
            results,
            campaignId: campaignId,
            stats: campaignData.stats
        });
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
                // Buscar columnas que contengan números de teléfono
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

    // Emitir estado actual al cliente que se acaba de conectar
    socket.emit('status', {
        ready: isClientReady,
        qrCode: qrCodeData
    });

    // Si ya está listo, también emitir el evento ready
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

// Crear directorios necesarios si no existen
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

if (!fs.existsSync('uploads/images')) {
    fs.mkdirSync('uploads/images', { recursive: true });
}

if (!fs.existsSync('public')) {
    fs.mkdirSync('public');
}

if (!fs.existsSync('logs')) {
    fs.mkdirSync('logs');
}

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
        
        // También guardar log detallado
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

// Función para guardar contactos
function saveContact(contactData) {
    try {
        const contactsFile = path.join('logs', 'contacts.json');
        let contacts = [];
        
        // Leer contactos existentes
        if (fs.existsSync(contactsFile)) {
            const data = fs.readFileSync(contactsFile, 'utf8');
            contacts = JSON.parse(data);
        }
        
        // Buscar si el contacto ya existe
        const existingIndex = contacts.findIndex(c => c.number === contactData.number);
        
        if (existingIndex >= 0) {
            // Actualizar contacto existente, preservando firstContact
            contacts[existingIndex] = {
                ...contacts[existingIndex],
                name: contactData.name,
                lastMessage: contactData.lastMessage,
                isGroup: contactData.isGroup
            };
        } else {
            // Agregar nuevo contacto
            contacts.push({
                ...contactData,
                firstContact: contactData.firstContact || new Date().toISOString()
            });
        }
        
        // Guardar contactos actualizados
        fs.writeFileSync(contactsFile, JSON.stringify(contacts, null, 2));
    } catch (error) {
        console.error('Error guardando contacto:', error);
    }
}

// Función para obtener todos los contactos
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