// Variables globales
let currentCampaignId = null;
let campaigns = [];

// Elementos del DOM
const totalCampaignsEl = document.getElementById('total-campaigns');
const totalSentEl = document.getElementById('total-sent');
const totalFailedEl = document.getElementById('total-failed');
const successRateEl = document.getElementById('success-rate');
const campaignsTableEl = document.getElementById('campaigns-table');
const campaignModal = new bootstrap.Modal(document.getElementById('campaignModal'));
const resendModal = new bootstrap.Modal(document.getElementById('resendModal'));
const resendFailedBtn = document.getElementById('resend-failed-btn');
const confirmResendBtn = document.getElementById('confirm-resend-btn');

// Funciones de utilidad
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('es-ES', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

function getSuccessRateClass(rate) {
    if (rate >= 90) return 'high';
    if (rate >= 70) return 'medium';
    return 'low';
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    
    const container = document.querySelector('.container');
    container.insertBefore(alertDiv, container.firstChild);
    
    setTimeout(() => {
        alertDiv.remove();
    }, 5000);
}

// Cargar estadísticas generales
async function loadStats() {
    try {
        const response = await fetch('/stats');
        const data = await response.json();
        
        if (data.success) {
            const stats = data.stats;
            totalCampaignsEl.textContent = stats.totalCampaigns;
            totalSentEl.textContent = stats.totalMessagesSent.toLocaleString();
            totalFailedEl.textContent = stats.totalMessagesFailed.toLocaleString();
            successRateEl.textContent = stats.averageSuccessRate + '%';
        }
    } catch (error) {
        console.error('Error cargando estadísticas:', error);
        showAlert('Error cargando estadísticas', 'danger');
    }
}

// Cargar historial de campañas
async function loadCampaigns() {
    try {
        const response = await fetch('/campaigns');
        const data = await response.json();
        
        if (data.success) {
            campaigns = data.campaigns;
            renderCampaignsTable();
        }
    } catch (error) {
        console.error('Error cargando campañas:', error);
        campaignsTableEl.innerHTML = `
            <tr>
                <td colspan="8" class="text-center text-danger">
                    <i class="fas fa-exclamation-triangle me-2"></i>
                    Error cargando campañas
                </td>
            </tr>
        `;
    }
}

// Renderizar tabla de campañas
function renderCampaignsTable() {
    if (campaigns.length === 0) {
        campaignsTableEl.innerHTML = `
            <tr>
                <td colspan="8" class="text-center text-muted">
                    <i class="fas fa-inbox me-2"></i>
                    No hay campañas registradas
                </td>
            </tr>
        `;
        return;
    }
    
    campaignsTableEl.innerHTML = campaigns.map(campaign => {
        const successRate = parseFloat(campaign.stats?.successRate || 0);
        const successRateClass = getSuccessRateClass(successRate);
        
        return `
            <tr class="campaign-row" data-campaign-id="${campaign.id}">
                <td>${formatDate(campaign.startTime)}</td>
                <td>
                    <span class="text-truncate d-inline-block" style="max-width: 200px;" title="${campaign.message}">
                        ${campaign.message}
                    </span>
                </td>
                <td><span class="badge bg-secondary">${campaign.totalNumbers}</span></td>
                <td><span class="badge bg-success">${campaign.stats?.sent || 0}</span></td>
                <td><span class="badge bg-danger">${campaign.stats?.failed || 0}</span></td>
                <td><span class="success-rate ${successRateClass}">${successRate}%</span></td>
                <td>${campaign.duration ? formatDuration(campaign.duration) : '-'}</td>
                <td>
                    <button class="btn btn-sm btn-outline-primary view-details-btn" data-campaign-id="${campaign.id}">
                        <i class="fas fa-eye"></i>
                    </button>
                    ${campaign.stats?.failed > 0 ? `
                        <button class="btn btn-sm btn-outline-warning resend-btn" data-campaign-id="${campaign.id}">
                            <i class="fas fa-redo"></i>
                        </button>
                    ` : ''}
                </td>
            </tr>
        `;
    }).join('');
    
    // Agregar event listeners
    document.querySelectorAll('.view-details-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            viewCampaignDetails(btn.dataset.campaignId);
        });
    });
    
    document.querySelectorAll('.resend-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showResendModal(btn.dataset.campaignId);
        });
    });
    
    document.querySelectorAll('.campaign-row').forEach(row => {
        row.addEventListener('click', () => {
            viewCampaignDetails(row.dataset.campaignId);
        });
    });
}

// Ver detalles de campaña
async function viewCampaignDetails(campaignId) {
    try {
        const response = await fetch(`/campaigns/${campaignId}`);
        const data = await response.json();
        
        if (data.success) {
            const campaign = data.campaign;
            currentCampaignId = campaignId;
            
            const detailsHtml = `
                <div class="row mb-3">
                    <div class="col-md-6">
                        <h6>Información General</h6>
                        <p><strong>ID:</strong> ${campaign.id}</p>
                        <p><strong>Inicio:</strong> ${formatDate(campaign.startTime)}</p>
                        <p><strong>Fin:</strong> ${campaign.endTime ? formatDate(campaign.endTime) : 'En progreso'}</p>
                        <p><strong>Duración:</strong> ${campaign.duration ? formatDuration(campaign.duration) : '-'}</p>
                        <p><strong>Tipo:</strong> ${campaign.type === 'resend' ? 'Reenvío' : 'Normal'}</p>
                    </div>
                    <div class="col-md-6">
                        <h6>Estadísticas</h6>
                        <p><strong>Total números:</strong> ${campaign.totalNumbers}</p>
                        <p><strong>Enviados:</strong> <span class="text-success">${campaign.stats?.sent || 0}</span></p>
                        <p><strong>Fallidos:</strong> <span class="text-danger">${campaign.stats?.failed || 0}</span></p>
                        <p><strong>Tasa de éxito:</strong> <span class="success-rate ${getSuccessRateClass(parseFloat(campaign.stats?.successRate || 0))}">${campaign.stats?.successRate || 0}%</span></p>
                    </div>
                </div>
                
                <div class="mb-3">
                    <h6>Mensaje</h6>
                    <div class="bg-light p-3 rounded">
                        ${campaign.message.replace(/\n/g, '<br>')}
                    </div>
                </div>
                
                <div class="mb-3">
                    <h6>Configuración</h6>
                    <div class="row">
                        <div class="col-md-3">
                            <small class="text-muted">Delay mín:</small><br>
                            <strong>${campaign.config?.minDelay || '-'}s</strong>
                        </div>
                        <div class="col-md-3">
                            <small class="text-muted">Delay máx:</small><br>
                            <strong>${campaign.config?.maxDelay || '-'}s</strong>
                        </div>
                        <div class="col-md-3">
                            <small class="text-muted">Pausa cada:</small><br>
                            <strong>${campaign.config?.longPauseInterval || '-'} msg</strong>
                        </div>
                        <div class="col-md-3">
                            <small class="text-muted">Orden aleatorio:</small><br>
                            <strong>${campaign.config?.randomizeOrder ? 'Sí' : 'No'}</strong>
                        </div>
                    </div>
                </div>
                
                <div>
                    <h6>Resultados Detallados</h6>
                    <div class="table-responsive" style="max-height: 300px; overflow-y: auto;">
                        <table class="table table-sm">
                            <thead class="table-light sticky-top">
                                <tr>
                                    <th>#</th>
                                    <th>Número</th>
                                    <th>Estado</th>
                                    <th>Timestamp</th>
                                    <th>Error</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${campaign.results.map(result => `
                                    <tr>
                                        <td>${result.index}</td>
                                        <td>${result.number}</td>
                                        <td>
                                            <span class="badge ${result.status === 'enviado' ? 'bg-success' : 'bg-danger'}">
                                                ${result.status === 'enviado' ? 'Enviado' : 'Error'}
                                            </span>
                                        </td>
                                        <td><small>${formatDate(result.timestamp)}</small></td>
                                        <td><small class="text-danger">${result.error || '-'}</small></td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
            
            document.getElementById('campaign-details').innerHTML = detailsHtml;
            
            // Mostrar botón de reenvío si hay números fallidos
            const failedCount = campaign.stats?.failed || 0;
            if (failedCount > 0) {
                resendFailedBtn.style.display = 'inline-block';
                resendFailedBtn.textContent = `Reenviar ${failedCount} Fallidos`;
            } else {
                resendFailedBtn.style.display = 'none';
            }
            
            campaignModal.show();
        }
    } catch (error) {
        console.error('Error cargando detalles:', error);
        showAlert('Error cargando detalles de la campaña', 'danger');
    }
}

// Mostrar modal de reenvío
function showResendModal(campaignId) {
    currentCampaignId = campaignId;
    const campaign = campaigns.find(c => c.id === campaignId);
    
    if (campaign) {
        document.getElementById('resend-message').value = campaign.message;
    }
    
    resendModal.show();
}

// Reenviar a números fallidos
async function resendFailed() {
    if (!currentCampaignId) return;
    
    const message = document.getElementById('resend-message').value.trim();
    const minDelay = document.getElementById('resend-min-delay').value;
    const maxDelay = document.getElementById('resend-max-delay').value;
    
    if (!message) {
        showAlert('Por favor ingresa un mensaje', 'warning');
        return;
    }
    
    confirmResendBtn.disabled = true;
    confirmResendBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Reenviando...';
    
    try {
        const response = await fetch(`/resend-failed/${currentCampaignId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message,
                minDelay: parseInt(minDelay),
                maxDelay: parseInt(maxDelay)
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showAlert(`Reenvío completado. ${data.stats?.sent || 0} mensajes enviados, ${data.stats?.failed || 0} fallidos.`, 'success');
            resendModal.hide();
            campaignModal.hide();
            
            // Recargar datos
            await loadStats();
            await loadCampaigns();
        } else {
            showAlert('Error en el reenvío: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error en reenvío:', error);
        showAlert('Error de conexión durante el reenvío', 'danger');
    } finally {
        confirmResendBtn.disabled = false;
        confirmResendBtn.innerHTML = '<i class="fas fa-paper-plane me-2"></i>Reenviar';
    }
}

// Event listeners
resendFailedBtn.addEventListener('click', () => {
    campaignModal.hide();
    showResendModal(currentCampaignId);
});

confirmResendBtn.addEventListener('click', resendFailed);

// Validación de delays
document.getElementById('resend-min-delay').addEventListener('input', (e) => {
    const maxDelay = parseInt(document.getElementById('resend-max-delay').value);
    const minDelay = parseInt(e.target.value);
    
    if (minDelay >= maxDelay) {
        document.getElementById('resend-max-delay').value = minDelay + 1;
    }
});

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    await loadStats();
    await loadCampaigns();
    
    // Actualizar cada 30 segundos
    setInterval(async () => {
        await loadStats();
        await loadCampaigns();
    }, 30000);
});

// Actualizar datos cuando se enfoca la ventana
window.addEventListener('focus', async () => {
    await loadStats();
    await loadCampaigns();
});