# Mensajes Masivos WhatsApp

Aplicación web para enviar mensajes masivos por WhatsApp usando whatsapp-web.js

## Características

- ✅ Envío de mensajes individuales
- ✅ Envío masivo desde lista de números
- ✅ Importación de números desde archivo CSV
- ✅ Interfaz web moderna y responsive
- ✅ Progreso en tiempo real del envío
- ✅ Autenticación mediante código QR
- ✅ Reporte de resultados detallado

## Instalación

1. **Clonar o descargar el proyecto**
   ```bash
   cd mensajes-masivos
   ```

2. **Instalar dependencias**
   ```bash
   npm install
   ```

3. **Ejecutar la aplicación**
   ```bash
   npm start
   ```

4. **Abrir en el navegador**
   ```
   http://localhost:3000
   ```

## Uso

### Primera vez
1. Al iniciar la aplicación, aparecerá un código QR
2. Abre WhatsApp en tu teléfono
3. Ve a **Configuración > Dispositivos vinculados**
4. Toca **Vincular un dispositivo**
5. Escanea el código QR mostrado en la aplicación
6. Una vez conectado, podrás enviar mensajes

### Envío Individual
1. Ingresa el número de teléfono (con código de país, sin +)
2. Escribe tu mensaje
3. Haz clic en "Enviar Mensaje"

### Envío Masivo

#### Opción 1: Lista de números
1. Escribe tu mensaje
2. En el área de texto, pega los números uno por línea:
   ```
   573001234567
   573007654321
   573009876543
   ```
3. Haz clic en "Enviar Masivo"

#### Opción 2: Archivo CSV
1. Crea un archivo CSV con una columna de números:
   ```csv
   telefono
   573001234567
   573007654321
   573009876543
   ```
2. Escribe tu mensaje
3. Selecciona el archivo CSV
4. Haz clic en "Enviar Masivo"

## Formato de números

- **Correcto**: `573001234567` (código país + número)
- **Incorrecto**: `+573001234567` o `3001234567`

## Características técnicas

- **Backend**: Node.js + Express
- **WhatsApp**: whatsapp-web.js
- **Frontend**: HTML5 + Bootstrap 5 + JavaScript
- **Tiempo real**: Socket.IO
- **Archivos**: Multer + CSV Parser

## Estructura del proyecto

```
mensajes-masivos/
├── server.js          # Servidor principal
├── package.json       # Dependencias
├── public/           # Archivos estáticos
│   ├── index.html    # Interfaz principal
│   └── script.js     # JavaScript del frontend
├── uploads/          # Archivos temporales (se crea automáticamente)
└── .wwebjs_auth/     # Datos de autenticación (se crea automáticamente)
```

## Notas importantes

- La primera conexión puede tardar unos minutos
- Los datos de autenticación se guardan localmente
- Se incluye una pausa de 2 segundos entre mensajes para evitar bloqueos
- Los archivos CSV se eliminan automáticamente después del procesamiento
- La aplicación funciona mientras WhatsApp Web esté disponible

## Solución de problemas

### El código QR no aparece
- Espera unos segundos, puede tardar en cargar
- Actualiza la página
- Verifica que no tengas WhatsApp Web abierto en otra pestaña

### Error de autenticación
- Elimina la carpeta `.wwebjs_auth`
- Reinicia la aplicación
- Escanea el código QR nuevamente

### Mensajes no se envían
- Verifica que el número incluya el código de país
- Asegúrate de que WhatsApp esté conectado
- Revisa que el número exista en WhatsApp

## Desarrollo

Para desarrollo con recarga automática:

```bash
npm run dev
```

## Licencia

MIT License - Puedes usar este código libremente para proyectos personales y comerciales.

---

**⚠️ Advertencia**: Usa esta aplicación de manera responsable. El envío masivo de mensajes puede violar los términos de servicio de WhatsApp si se usa para spam. Úsala solo para comunicaciones legítimas con contactos que hayan dado su consentimiento.