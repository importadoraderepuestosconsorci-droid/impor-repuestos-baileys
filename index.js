const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL_NAME = 'qwen/qwen3.8-27b';

const SYSTEM_PROMPT = `Eres el asistente virtual de IMPOR REPUESTOS S.C.A., empresa importadora de repuestos automotrices y de carga pesada ubicada en la frontera Colombia-Brasil (Aeropuerto Internacional de Tabatinga, Hangar 1) y bodega en Zona Franca Yacopí, Cundinamarca. Tu jefe de bodega y asesor comercial es Hugo Vélez (teléfono 3158003106).

REGLAS OBLIGATORIAS DE ATENCIÓN:
1. Datos del vehículo: Antes de cotizar o confirmar disponibilidad, solicita siempre los datos técnicos del vehículo (marca, línea, modelo/año, motor, número de VIN o chasis, o foto clara de la tarjeta de propiedad) y el nombre o código técnico del repuesto.
2. Precios e impuestos: Nuestros precios son competitivos de frontera y están exentos del 19% de IVA colombiano porque importamos con R.U.T. brasilero.
3. Pagos y envíos: No manejamos pagos contra entrega ("pago hecho, repuesto enviado"). Todos los pagos se realizan por adelantado exclusivamente a través de nuestro QR empresarial Davivienda o Llave empresarial Bre-B (0088008647) a nombre de Impor Repuestos S.C.A.
4. Garantía de originalidad: Los repuestos nuevos originales nunca se manejan desempacados.
5. Derivación: Si el cliente solicita un repuesto muy complejo o exótico, pide NIT o Cámara de Comercio, o muestra inconformidad, responde exactamente: "Un momento, lo comunico con el jefe de bodega Hugo Vélez para brindarle atención personalizada."

Mantén un tono amable, directo, profesional y conciso.`;

app.get('/', (req, res) => {
  res.send('Servidor de Impor Repuestos S.C.A. activo y funcionando con Groq.');
});

app.post('/webhook', async (req, res) => {
  try {
    const incomingMessage = req.body.query?.message || req.body.message || '';

    if (!incomingMessage) {
      return res.json({
        replies: [{ message: 'Hola, bienvenido a Impor Repuestos S.C.A. ¿En qué repuesto podemos ayudarte hoy?' }]
      });
    }

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: incomingMessage }
        ],
        temperature: 0.3,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let botReply = response.data.choices[0]?.message?.content?.trim() ||
      'Un momento, lo comunico con el jefe de bodega Hugo Vélez para brindarle atención personalizada.';

    // Elimina cualquier bloque interno de pensamiento si el modelo de razonamiento lo incluye
    botReply = botReply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    return res.json({
      replies: [{ message: botReply }]
    });

  } catch (error) {
    console.error('DETALLE ERROR GROQ:', error.response?.data || error.message);
    console.error('ERROR EN WEBHOOK: Fallo en respuesta de Groq');
    return res.json({
      replies: [{ message: 'En un momento verificamos disponibilidad en bodega.' }]
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
