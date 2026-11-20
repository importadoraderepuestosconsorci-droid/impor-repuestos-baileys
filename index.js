const express = require('express');
const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Memoria temporal por cliente (guarda historial y estado de transferencia)
const sesiones = new Map();

const MENSAJE_FOTO = 'Un momento, te comunico al gerente de ventas Hugo Vélez para que se apersone de tu repuesto. Feliz día.';
const MENSAJE_COTIZACION = 'Un momento, te transfiero la llamada con el gerente de ventas Hugo Vélez para que acabe de cerrar el negocio. Feliz día.';

const SYSTEM_PROMPT = `Eres el agente autónomo de ventas de IMPOR REPUESTOS S.C.A., empresa importadora y distribuidora directa de repuestos automotrices originales y homologados desde Brasil hacia toda Colombia, dirigida por el gerente de ventas Hugo Vélez.

UBICACIONES Y OPERACIÓN:
- Sede principal de importación: Hangar 1, Aeropuerto Internacional de Tabatinga (frontera Colombia - Brasil).
- Bodega de distribución nacional: Zona Franca de Yacopí, Cundinamarca (Local 3307).
- Línea oficial de soporte y WhatsApp: 3158003106.

FLUJO OBLIGATORIO DE VENTAS (SEGUIR EN ORDEN ESTRICTO):

PASO 1 - PRESENTACIÓN FORMAL Y ELECCIÓN TEXTO VS. FOTO:
- Cuando el cliente salude o pregunte por un repuesto sin haber enviado los datos completos del vehículo, preséntate formalmente y dale a elegir con este mensaje exacto:
  "¡Bienvenido a IMPOR REPUESTOS S.C.A.! Somos importadores directos desde Brasil hacia toda Colombia. Si me envías fotos, debes esperar a que el gerente de ventas Hugo Vélez te atienda para hacerte esa cotización. Si me escribes todos los datos en texto (repuesto que necesitas, marca, año y número de chasis/VIN), yo realizo la cotización mucho más rápido al instante. Ya tú decides. Muchas gracias."
- IMPORTANTE: Espera a que el cliente envíe los datos del vehículo y el VIN en texto antes de dar precios. Si envió solo una parte (ej. solo la marca), pídele amablemente en texto los datos que faltan (año, VIN/chasis y repuesto) sin repetir toda la presentación.

PASO 2 - COTIZACIÓN EN LÍNEA (ORIGINAL Y HOMOLOGADO A PRECIO INTERMEDIO ÚNICO):
- Apenas el cliente entregue los datos completos del vehículo y el repuesto en texto, verifica el valor comercial real en pesos colombianos (COP) para ese vehículo y pieza exacta, y entrega DOS OPCIONES CON PRECIO INTERMEDIO ÚNICO (una sola cifra redonda y firme por opción; PROHIBIDO dar rangos como "entre X y Y"):
  * **Repuesto Original:** $[PRECIO INTERMEDIO ORIGINAL] (nuevo original sellado de fábrica con garantía de 1 año).
  * **Repuesto Homologado:** $[PRECIO INTERMEDIO HOMOLOGADO] (calidad certificada de importación).
- Aclara siempre que son precios directos de frontera sin IVA del 19%.
- **NORMA MAYORISTA (SUPERIOR A $250.000 COP):** Somos proveedores mayoristas, NO minoristas al detal. Si el repuesto cotizado vale $250.000 COP o menos, dile amablemente: "Somos proveedores mayoristas y únicamente despachamos compras superiores a $250.000 COP. Para esta pieza individual de menor cuantía debes conseguirla con un proveedor minorista local, o si deseas agregar más repuestos para superar los $250.000 COP con gusto te cotizamos el pedido. Feliz día."
- Si el valor supera los $250.000 COP, termina el mensaje SIEMPRE con esta pregunta exacta:
  "¿Deseas realizar la compra o deseas que te envíe la cotización?"

PASO 3A - SI EL CLIENTE DICE QUE DESEA REALIZAR LA COMPRA / PIDE DATOS DE PAGO:
- Envíale de inmediato los datos oficiales de pago:
  * **Llave empresarial Bre-B:** 0088008647 (a nombre de IMPOR REPUESTOS S.C.A.)
  * **Código QR corporativo Davivienda** (indicar que también puede solicitar la imagen del QR si la requiere).
  * Condición: Pago 100% anticipado previo al despacho (pago hecho, repuesto enviado; bajo ninguna circunstancia manejamos pago contra entrega).
  * Nota tributaria (solo si pregunta): Importamos con R.U.T. brasilero; no manejamos NIT ni Cámara de Comercio colombiana.

PASO 3B - SI EL CLIENTE DICE QUE NECESITA QUE LE HAGAN LA COTIZACIÓN (O QUIERE CERRAR CON ASESOR):
- Detén el flujo automático y responde TEXTUALMENTE:
  "${MENSAJE_COTIZACION}"

REGLA DE ORO: Sé breve, cordial y directo. Jamás menciones enlaces, páginas web externas ni muestres procesos internos; entrega únicamente la respuesta comercial limpia al cliente.`;

// Detecta si AutoResponder recibió una foto (tarjeta de propiedad o repuesto)
function esMensajeConFoto(texto) {
  const limpio = texto.toLowerCase().trim();
  return (
    limpio.includes('📷') ||
    limpio.includes('imagen') ||
    limpio.includes('foto') ||
    limpio === 'image' ||
    limpio === '[image]' ||
    limpio.startsWith('http')
  );
}

// Consulta los modelos activos de tu cuenta Groq con respaldo automático
async function consultarGroq(mensajes) {
  const modelos = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'];

  for (const modelo of modelos) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelo,
          messages: mensajes,
          temperature: 0.2,
          max_tokens: 400
        })
      });

      const data = await response.json();
      if (response.ok && data.choices?.[0]?.message?.content) {
        return data.choices[0].message.content.trim();
      }
      console.warn(`Aviso con modelo ${modelo}:`, JSON.stringify(data));
    } catch (err) {
      console.error(`Fallo de red con modelo ${modelo}:`, err);
    }
  }
  return null;
}

app.post('/webhook', async (req, res) => {
  try {
    const query = req.body.query || {};
    const sender = query.sender || 'Cliente';
    const message = (query.message || '').trim();

    if (!message) {
      return res.json({
        replies: [{ message: MENSAJE_FOTO }]
      });
    }

    // Obtener o crear sesión del cliente
    let sesion = sesiones.get(sender) || { historial: [], transferido: false, mensajeCierre: MENSAJE_COTIZACION, ultimaActividad: Date.now() };

    // Reiniciar sesión si pasaron más de 2 horas de inactividad
    if (Date.now() - sesion.ultimaActividad > 2 * 60 * 60 * 1000) {
      sesion = { historial: [], transferido: false, mensajeCierre: MENSAJE_COTIZACION, ultimaActividad: Date.now() };
    }
    sesion.ultimaActividad = Date.now();

    // 1. SI EL CLIENTE YA FUE TRANSFERIDO A HUGO VÉLEZ: repetir su aviso correspondiente y frenar
    if (sesion.transferido) {
      sesiones.set(sender, sesion);
      return res.json({
        replies: [{ message: sesion.mensajeCierre }]
      });
    }

    // 2. SI LLEGA UNA FOTO (tarjeta de propiedad o repuesto): frenar ahí y avisar que Hugo Vélez se apersona
    if (esMensajeConFoto(message)) {
      sesion.transferido = true;
      sesion.mensajeCierre = MENSAJE_FOTO;
      sesiones.set(sender, sesion);
      return res.json({
        replies: [{ message: MENSAJE_FOTO }]
      });
    }

    // Guardar historial del cliente (últimos 8 mensajes para mantener contexto)
    sesion.historial.push({ role: 'user', content: message });
    if (sesion.historial.length > 8) {
      sesion.historial = sesion.historial.slice(-8);
    }

    const mensajesParaIA = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...sesion.historial
    ];

    let replyText = await consultarGroq(mensajesParaIA);

    if (!replyText) {
      return res.json({
        replies: [{ message: MENSAJE_COTIZACION }]
      });
    }

    replyText = replyText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Si la IA decidió transferir al cliente a Hugo Vélez, activar bloqueo para los siguientes mensajes
    if (replyText.includes('transfiero la llamada con el gerente de ventas Hugo Vélez')) {
      sesion.transferido = true;
      sesion.mensajeCierre = MENSAJE_COTIZACION;
    }

    sesion.historial.push({ role: 'assistant', content: replyText });
    sesiones.set(sender, sesion);

    return res.json({
      replies: [{ message: replyText }]
    });

  } catch (error) {
    console.error('Error en el servidor:', error);
    return res.json({
      replies: [{ message: MENSAJE_COTIZACION }]
    });
  }
});

app.get('/', (req, res) => {
  res.send('Servidor de IMPOR REPUESTOS S.C.A. activo.');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = 'impor_repuestos_123';

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado con éxito');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor de IMPOR REPUESTOS corriendo en puerto ${PORT}`);
});
                    
          
