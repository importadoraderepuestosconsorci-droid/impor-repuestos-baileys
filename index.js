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
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let pairingCode = null;
let connectionStatus = 'Iniciando servidor...';

const SYSTEM_PROMPT = `Eres el asesor virtual oficial de IMPOR REPUESTOS S.C.A., importadores y distribuidores de repuestos originales y homologados desde Brasil, dirigidos por el jefe de bodega Hugo Vélez.
Sedes: Hangar 1 Aeropuerto Internacional de Tabatinga (frontera Colombia-Brasil) y Zona Franca Yacopí, Cundinamarca (Local 3307). Línea de soporte: 3158003106.

REGLAS OBLIGATORIAS:
1. DATOS TÉCNICOS: Antes de cotizar, pide siempre marca, línea, modelo/año y número de chasis o VIN (o foto de la tarjeta de propiedad) para confirmar compatibilidad exacta.
2. PRECIOS E IVA: Nuestros precios son importados por zona fronteriza y NO incluyen el 19% de IVA colombiano. La cuantía
                       
