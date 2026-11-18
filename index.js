const express = require('express');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    initAuthCreds,
    BufferJSON
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const Groq = require('groq-sdk');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let pairingCode = null;
let qrCodeDataUrl = null;
let connectionStatus = 'Iniciando servidor...';
let sock = null;

const SYSTEM_PROMPT = `Eres el asesor virtual oficial de IMPOR REPUESTOS S.C.A., importadores y distribuidores de repuestos originales y homologados.
Sedes: Hangar 1 Aeropuerto Internacional de Tabatinga (frontera Colombia-Brasil) y Zona Franca Yacopí, Cundinamarca.
Teléfono de soporte y ventas: 3158003106.

REGLAS OBLIGATORIAS:
1. DATOS TÉCNICOS: Antes de cotizar, pide siempre marca, línea, modelo/año y número de chasis o VIN (o foto de la tarjeta de propiedad).
2. PRECIOS E IVA: Nuestros precios son importados por zona fronteriza y NO incluyen el 19% de IVA colombiano. La cuantía mínima de despacho es de $250.000 COP.
3. PAGOS Y ENVÍOS: No manejamos pago contraentrega. Todo despacho se realiza únicamente tras confirmar el pago del 100% vía QR corporativo Davivienda o llave empresarial Bre-B: 0088008647.
4. DOCUMENTACIÓN: Importamos con R.U.T. brasilero; si un cliente solicita NIT o Cámara de Comercio, o pide un repuesto exótico/complejo o muestra inconformidad, responde exactamente: "Un momento, lo comunico con el jefe de bodega Hugo Vélez para validar disponibilidad y despacho directo."
5. GARANTÍA: Todos los repuestos originales vienen sellados de fábrica con garantía de 1 año (no se destapan antes del envío).
6. ESTILO: Sé amable, concreto, profesional y directo. No inventes precios si no tienes la referencia confirmada.`;

// Adaptador de sesión en MongoDB para no perder la conexión en Render
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.replaceOne({ _id: id }, { _id: id, ...serialized }, { upsert: true });
    };

    const readData = async (id) => {
        const doc = await collection.findOne({ _id: id });
        if (!doc) return null;
        const { _id, ...rest } = doc;
        return JSON.parse(JSON.stringify(rest), BufferJSON.reviver);
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function connectToWhatsApp() {
    try {
        const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) {
            connectionStatus = 'Error: Falta variable MONGODB_URI en Render';
            console.error(connectionStatus);
            return;
        }

        const client = new MongoClient(mongoUri);
        await client.connect();
        const db = client.db('impor_repuestos_bot');
        const authCollection = db.collection('baileys_auth');

        const { state, saveCreds } = await useMongoDBAuthState(authCollection);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: ['Impor Repuestos Bot', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeDataUrl = await QRCode.toDataURL(qr);
                connectionStatus = 'Esperando vinculación (Escanea el QR o usa código)';
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                connectionStatus = `Desconectado (${statusCode || 'error'}). Reconectando...`;
                qrCodeDataUrl = null;
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    connectionStatus = 'Sesión cerrada. Borra la colección en MongoDB para volver a vincular.';
                }
            } else if (connection === 'open') {
                connectionStatus = 'Conectado y operando en línea';
                qrCodeDataUrl = null;
                pairingCode = null;
                console.log('Bot conectado exitosamente a WhatsApp');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const remoteJid = msg.key.remoteJid;
            if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

            const userText =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                '';

            if (!userText.trim()) return;

            try {
                await sock.sendPresenceUpdate('composing', remoteJid);

                const completion = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: userText }
                    ],
                    temperature: 0.4,
                    max_tokens: 500
                });

                const reply = completion.choices[0]?.message?.content;
                if (reply) {
                    // Pausa natural de 5 segundos antes de responder
                    await new Promise((resolve) => setTimeout(resolve, 5000));
                    await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
                }
            } catch (err) {
                console.error('Error procesando mensaje con Groq:', err);
            }
        });
    } catch (error) {
        connectionStatus = `Error de inicio: ${error.message}`;
        console.error(error);
    }
}

// Panel web para ver estado y vincular desde el celular
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Impor Repuestos S.C.A. - Bot</title>
            <style>
                body { font-family: sans-serif; background: #111; color: #fff; text-align: center; padding: 20px; }
                .card { background: #1e1e1e; padding: 20px; border-radius: 12px; max-width: 400px; margin: auto; }
                input, button { padding: 12px; width: 90%; margin: 8px 0; border-radius: 8px; border: none; font-size: 16px; }
                button { background: #25D366; color: #000; font-weight: bold; cursor: pointer; }
                .code { font-size: 28px; letter-spacing: 4px; color: #25D366; font-weight: bold; margin: 15px 0; }
                img { max-width: 250px; border-radius: 8px; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>IMPOR REPUESTOS S.C.A.</h2>
                <p><strong>Estado:</strong> ${connectionStatus}</p>
                ${qrCodeDataUrl ? `<img src="${qrCodeDataUrl}" alt="Código QR" />` : ''}
                ${pairingCode ? `<div class="code">${pairingCode}</div>` : ''}
                <hr style="border-color:#333; margin: 20px 0;">
                <p>Vincular con número de teléfono (sin +):</p>
                <form action="/pair" method="GET">
                    <input type="text" name="phone" placeholder="Ej: 573158003106" required />
                    <button type="submit">Generar Código de Vinculación</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.get('/pair', async (req, res) => {
    const phone = (req.query.phone || '').replace(/\D/g, '');
    if (!phone || !sock) {
        return res.redirect('/');
    }
    try {
        pairingCode = await sock.requestPairingCode(phone);
    } catch (e) {
        connectionStatus = `Error generando código: ${e.message}`;
    }
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    connectToWhatsApp();
});
          
