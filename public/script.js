// Conexión Socket.IO
const socket = io();

// Elementos del DOM
const statusElement = document.getElementById('status');
const qrSection = document.getElementById('qr-section');
const qrCodeImg = document.getElementById('qr-code');
const requestQrBtn = document.getElementById('request-qr-btn');
const mainContent = document.getElementById('main-content');
const singleMessageForm = document.getElementById('single-message-form');
const bulkMessageForm = document.getElementById('bulk-message-form');
const resultsDiv = document.getElementById('results');
const progressContainer = document.querySelector('.progress-container');
const progressBar = document.querySelector('.progress-bar');
const progressText = document.querySelector('.progress-text');
const currentNumberText = document.querySelector('.current-number');

// Agregar estilos dinámicos para animaciones
const style = document.createElement('style');
style.textContent = `
    @keyframes pulse {
        0% { opacity: 1; }
        50% { opacity: 0.7; }
        100% { opacity: 1; }
    }
    @keyframes slideIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
    }
    .qr-wrapper img {
        animation: slideIn 0.5s ease-out;
    }
    #status {
        animation: pulse 2s infinite;
    }
    #status.status-connected {
        animation: none;
    }
`;
document.head.appendChild(style);

// Estado de la aplicación
let isReady = false;

// Eventos Socket.IO
socket.on('status', (data) => {
    updateStatus(data.ready, data.qrCode);
});

socket.on('qr', (qrCode) => {
    showQRCode(qrCode);
});

socket.on('ready', () => {
    updateStatus(true);
});

socket.on('authenticated', () => {
    showAlert('¡Autenticación exitosa!', 'success');
});

socket.on('disconnected', () => {
    updateStatus(false);
    showAlert('Conexión perdida con WhatsApp. Reintentando...', 'warning');
});

socket.on('auth_failure', (msg) => {
    updateStatus(false);
    showAlert('Error de autenticación: ' + msg + '. Por favor, escanea el código QR nuevamente.', 'danger');
});

socket.on('progress', (data) => {
    updateProgress(data.current, data.total, data.number);
});

// Funciones de UI
function updateStatus(ready, qrCode = null) {
    isReady = ready;
    
    if (ready) {
        statusElement.innerHTML = '<span class="status-indicator status-connected"></span>Conectado y listo';
        qrSection.style.display = 'none';
        requestQrBtn.style.display = 'none';
        mainContent.style.display = 'block';
    } else if (qrCode) {
        statusElement.innerHTML = '<span class="status-indicator status-connecting"></span>Esperando escaneo del QR';
        requestQrBtn.style.display = 'none';
        showQRCode(qrCode);
    } else {
        statusElement.innerHTML = '<span class="status-indicator status-disconnected"></span>Desconectado';
        qrSection.style.display = 'none';
        requestQrBtn.style.display = 'inline-block';
        mainContent.style.display = 'none';
    }
}

function showQRCode(qrCode) {
    qrSection.style.display = 'block';
    requestQrBtn.style.display = 'none';
    mainContent.style.display = 'none';

    if (qrCode) {
        // Agregar clase de animación
        qrCodeImg.classList.add('qr-success-animation');
        qrCodeImg.src = qrCode;
        qrCodeImg.onerror = () => {
            console.error('Error cargando la imagen QR');
            showAlert('Error al mostrar el código QR. Intenta solicitar uno nuevo.', 'danger');
        };
        qrCodeImg.onload = () => {
            qrCodeImg.style.display = 'block';
        };
    } else {
        // Mostrar que se está generando
        showAlert('Generando código QR... Por favor espera.', 'info');
    }
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    resultsDiv.appendChild(alertDiv);
    
    // Auto-dismiss después de 5 segundos
    setTimeout(() => {
        if (alertDiv.parentNode) {
            alertDiv.remove();
        }
    }, 5000);
}

function updateProgress(current, total, number) {
    const percentage = (current / total) * 100;
    progressBar.style.width = `${percentage}%`;
    progressText.textContent = `${current} de ${total} mensajes enviados`;
    currentNumberText.textContent = `Enviando a: ${number}`;
    
    if (current === total) {
        setTimeout(() => {
            progressContainer.style.display = 'none';
            currentNumberText.textContent = '';
        }, 2000);
    }
}

function showResults(results) {
    const successCount = results.filter(r => r.status === 'enviado').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    
    const resultCard = document.createElement('div');
    resultCard.className = 'card mt-3';
    resultCard.innerHTML = `
        <div class="card-header">
            <h5 class="mb-0">
                <i class="fas fa-chart-bar me-2"></i>
                Resultados del Envío
            </h5>
        </div>
        <div class="card-body">
            <div class="row">
                <div class="col-md-6">
                    <div class="alert alert-success">
                        <i class="fas fa-check-circle me-2"></i>
                        <strong>Exitosos:</strong> ${successCount}
                    </div>
                </div>
                <div class="col-md-6">
                    <div class="alert alert-danger">
                        <i class="fas fa-exclamation-circle me-2"></i>
                        <strong>Errores:</strong> ${errorCount}
                    </div>
                </div>
            </div>
            ${errorCount > 0 ? `
                <div class="mt-3">
                    <h6>Números con errores:</h6>
                    <ul class="list-group">
                        ${results.filter(r => r.status === 'error')
                                .map(r => `<li class="list-group-item list-group-item-danger">
                                    ${r.number}: ${r.error}
                                </li>`).join('')}
                    </ul>
                </div>
            ` : ''}
        </div>
    `;
    
    resultsDiv.appendChild(resultCard);
}

// Manejadores de formularios
singleMessageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!isReady) {
        showAlert('WhatsApp no está conectado', 'warning');
        return;
    }
    
    const number = document.getElementById('single-number').value.trim();
    const message = document.getElementById('single-message').value.trim();
    const imageFile = document.getElementById('single-image').files[0];
    
    if (!number || !message) {
        showAlert('Por favor completa todos los campos', 'warning');
        return;
    }
    
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Enviando...';
    submitBtn.disabled = true;
    
    try {
        let response;
        
        if (imageFile) {
            // Enviar mensaje con imagen
            const formData = new FormData();
            formData.append('number', number);
            formData.append('message', message);
            formData.append('image', imageFile);
            
            response = await fetch('/send-message-with-image', {
                method: 'POST',
                body: formData
            });
        } else {
            // Enviar mensaje de texto normal
            response = await fetch('/send-message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ number, message })
            });
        }
        
        const result = await response.json();
        
        if (result.success) {
            showAlert('¡Mensaje enviado correctamente!', 'success');
            singleMessageForm.reset();
            // Limpiar vista previa de imagen
            document.getElementById('image-preview').style.display = 'none';
            document.getElementById('preview-img').src = '';
        } else {
            showAlert(`Error: ${result.error}`, 'danger');
        }
    } catch (error) {
        showAlert(`Error de conexión: ${error.message}`, 'danger');
    } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
});

bulkMessageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!isReady) {
        showAlert('WhatsApp no está conectado', 'warning');
        return;
    }
    
    const message = document.getElementById('bulk-message').value.trim();
    const csvFile = document.getElementById('csv-file').files[0];
    const numbers = document.getElementById('bulk-numbers').value.trim();
    const imageFile = document.getElementById('bulk-image').files[0];
    
    // Obtener parámetros de configuración humanizada
    const minDelay = parseInt(document.getElementById('min-delay').value) || 3;
    const maxDelay = parseInt(document.getElementById('max-delay').value) || 6;
    const longPauseInterval = parseInt(document.getElementById('long-pause-interval').value) || 10;
    const longPauseDelay = parseInt(document.getElementById('long-pause-delay').value) || 30;
    const randomizeOrder = document.getElementById('randomize-order').checked;
    
    if (!message) {
        showAlert('Por favor escribe un mensaje', 'warning');
        return;
    }
    
    if (!csvFile && !numbers) {
        showAlert('Por favor proporciona números de teléfono (archivo CSV o lista)', 'warning');
        return;
    }
    
    // Validar que minDelay sea menor que maxDelay
    if (minDelay >= maxDelay) {
        showAlert('El delay mínimo debe ser menor que el delay máximo', 'warning');
        return;
    }
    
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Enviando...';
    submitBtn.disabled = true;
    
    const requestData = {
        message,
        minDelay,
        maxDelay,
        longPauseInterval,
        longPauseDelay,
        randomizeOrder
    };
    
    // Determinar si usar la ruta con imagen o sin imagen
    const useImageRoute = imageFile !== undefined;
    const endpoint = useImageRoute ? '/send-bulk-with-image' : '/send-bulk';
    
    if (csvFile || useImageRoute) {
        // Para archivos CSV o imágenes, usar FormData
        const formData = new FormData();
        formData.append('message', message);
        formData.append('minDelay', minDelay);
        formData.append('maxDelay', maxDelay);
        formData.append('longPauseInterval', longPauseInterval);
        formData.append('longPauseDelay', longPauseDelay);
        formData.append('randomizeOrder', randomizeOrder);
        
        if (imageFile) {
            formData.append('image', imageFile);
        }
        if (csvFile) {
            formData.append('csvFile', csvFile);
        }
        if (numbers) {
            formData.append('numbers', numbers);
        }
        
        // Mostrar progreso
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        progressText.textContent = 'Iniciando envío...';
        
        try {
             const response = await fetch(endpoint, {
                 method: 'POST',
                 body: formData
             });
             
             const result = await response.json();
             
             if (response.ok) {
                 showAlert(result.message || 'Envío completado exitosamente', 'success');
                 progressText.textContent = 'Envío completado';
                 progressBar.style.width = '100%';
                 progressBar.classList.remove('progress-bar-animated');
                 progressBar.classList.add('bg-success');
                 
                 // Limpiar vista previa de imagen
                 const bulkImagePreview = document.getElementById('bulk-image-preview');
                 const bulkImageInput = document.getElementById('bulk-image');
                 if (bulkImagePreview && bulkImageInput) {
                     bulkImageInput.value = '';
                     bulkImagePreview.style.display = 'none';
                 }
             } else {
                 throw new Error(result.error || 'Error en el envío');
             }
         } catch (error) {
             console.error('Error:', error);
             showAlert('Error en el envío masivo: ' + error.message, 'danger');
             progressBar.classList.add('bg-danger');
         }
     } else {
         // Para números directos, usar JSON
         // Enviar como cadena de texto separada por saltos de línea
         requestData.numbers = numbers.split('\n').map(num => num.trim()).filter(num => num.length > 0).join('\n');
         
         try {
             const response = await fetch('/send-bulk', {
                 method: 'POST',
                 headers: {
                     'Content-Type': 'application/json'
                 },
                 body: JSON.stringify(requestData)
             });
         
             const result = await response.json();
            
             if (result.success) {
                 showAlert('¡Envío masivo completado!', 'success');
                 showResults(result.results);
                 bulkMessageForm.reset();
                 
                 // Limpiar vista previa de imagen
                 const bulkImagePreview = document.getElementById('bulk-image-preview');
                 const bulkImageInput = document.getElementById('bulk-image');
                 if (bulkImagePreview && bulkImageInput) {
                     bulkImageInput.value = '';
                     bulkImagePreview.style.display = 'none';
                 }
             } else {
                 showAlert(`Error: ${result.error}`, 'danger');
             }
         } catch (error) {
             showAlert(`Error de conexión: ${error.message}`, 'danger');
         }
     }
     
     // Restaurar botón y ocultar progreso
     submitBtn.innerHTML = originalText;
     submitBtn.disabled = false;
     setTimeout(() => {
         progressContainer.style.display = 'none';
     }, 2000);
});

// Validación de números de teléfono
document.getElementById('single-number').addEventListener('input', (e) => {
    let value = e.target.value.replace(/\D/g, ''); // Solo números
    e.target.value = value;
});

// Limpiar resultados anteriores al enviar nuevo
singleMessageForm.addEventListener('submit', () => {
    resultsDiv.innerHTML = '';
});

bulkMessageForm.addEventListener('submit', () => {
    resultsDiv.innerHTML = '';
});

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    // Verificar estado inicial
    fetch('/status')
        .then(response => response.json())
        .then(data => {
            updateStatus(data.ready, data.qrCode);
        })
        .catch(error => {
            console.error('Error obteniendo estado:', error);
        });
});

// Manejo de archivos CSV
document.getElementById('csv-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        document.getElementById('bulk-numbers').value = '';
        document.getElementById('bulk-numbers').placeholder = 'Archivo CSV seleccionado: ' + file.name;
    } else {
        document.getElementById('bulk-numbers').placeholder = 'Pega los números aquí, uno por línea...';
    }
});

document.getElementById('bulk-numbers').addEventListener('input', (e) => {
    if (e.target.value.trim()) {
        document.getElementById('csv-file').value = '';
    }
});

// Evento para solicitar QR manualmente
async function requestQR(force = false) {
    requestQrBtn.disabled = true;
    requestQrBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Solicitando QR...';
    
    try {
        const response = await fetch('/request-qr', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ force })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showAlert(result.message || 'Código QR solicitado. Espera un momento...', 'success');
        } else {
            if (result.canForce) {
                // Mostrar opción para forzar reinicio
                const alertDiv = document.createElement('div');
                alertDiv.className = 'alert alert-warning alert-dismissible fade show';
                alertDiv.innerHTML = `
                    <strong>Proceso en curso:</strong> ${result.error}<br>
                    <small class="text-muted">${result.message}</small><br>
                    <div class="mt-2">
                        <button class="btn btn-sm btn-warning me-2" onclick="forceQRRestart()">
                            <i class="fas fa-redo me-1"></i>Forzar Reinicio
                        </button>
                        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
                    </div>
                `;
                
                const container = document.querySelector('.container');
                const existingAlert = container.querySelector('.alert');
                if (existingAlert) {
                    existingAlert.remove();
                }
                container.insertBefore(alertDiv, container.firstChild);
            } else {
                showAlert('Error al solicitar QR: ' + result.error, 'danger');
            }
        }
    } catch (error) {
        showAlert('Error de conexión: ' + error.message, 'danger');
    } finally {
        requestQrBtn.disabled = false;
        requestQrBtn.innerHTML = '<i class="fas fa-qrcode me-2"></i>Solicitar Código QR';
    }
}

function forceQRRestart() {
    // Remover alertas existentes
    const alerts = document.querySelectorAll('.alert');
    alerts.forEach(alert => alert.remove());
    
    // Solicitar QR con fuerza
    requestQR(true);
}

requestQrBtn.addEventListener('click', () => requestQR(false));

// Funcionalidad para vista previa de imagen
document.getElementById('single-image').addEventListener('change', function(e) {
    const file = e.target.files[0];
    const preview = document.getElementById('image-preview');
    const previewImg = document.getElementById('preview-img');
    
    if (file) {
        // Validar tamaño del archivo (5MB máximo)
        if (file.size > 5 * 1024 * 1024) {
            showAlert('La imagen es demasiado grande. Tamaño máximo: 5MB', 'warning');
            e.target.value = '';
            preview.style.display = 'none';
            return;
        }
        
        // Validar tipo de archivo
        if (!file.type.startsWith('image/')) {
            showAlert('Por favor selecciona un archivo de imagen válido', 'warning');
            e.target.value = '';
            preview.style.display = 'none';
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(e) {
            previewImg.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
    } else {
        preview.style.display = 'none';
        previewImg.src = '';
    }
});

// Botón para quitar imagen
document.getElementById('remove-image').addEventListener('click', function() {
    document.getElementById('single-image').value = '';
    document.getElementById('image-preview').style.display = 'none';
    document.getElementById('preview-img').src = '';
});

// Event listeners para imagen en mensajes masivos
document.getElementById('bulk-image').addEventListener('change', function(e) {
    const file = e.target.files[0];
    const preview = document.getElementById('bulk-image-preview');
    const previewImg = document.getElementById('bulk-preview-img');
    
    if (file) {
        // Validar tipo de archivo
        const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
        if (!validTypes.includes(file.type)) {
            showAlert('Tipo de archivo no válido. Solo se permiten JPG, PNG y GIF.', 'warning');
            e.target.value = '';
            return;
        }
        
        // Validar tamaño (5MB máximo)
        const maxSize = 5 * 1024 * 1024; // 5MB en bytes
        if (file.size > maxSize) {
            showAlert('El archivo es demasiado grande. Tamaño máximo: 5MB.', 'warning');
            e.target.value = '';
            return;
        }
        
        // Mostrar vista previa
        const reader = new FileReader();
        reader.onload = function(e) {
            previewImg.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
    } else {
        preview.style.display = 'none';
    }
});

document.getElementById('remove-bulk-image').addEventListener('click', function() {
    const imageInput = document.getElementById('bulk-image');
    const imagePreview = document.getElementById('bulk-image-preview');
    
    imageInput.value = '';
    imagePreview.style.display = 'none';
});