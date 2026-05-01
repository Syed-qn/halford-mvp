// Storage abstraction. When MinIO env vars are set, drawings + outputs
// flow through S3-compatible object storage. Otherwise we fall back to the
// local filesystem for dev workflows.

const fs = require('fs');
const path = require('path');

const useMinio = !!process.env.MINIO_ENDPOINT;
let _client = null;

function client() {
  if (!useMinio) return null;
  if (_client) return _client;
  // Lazy-loaded so dev installs without minio dependency still work.
  const Minio = require('minio');
  _client = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT,
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
  });
  return _client;
}

const DRAWINGS_BUCKET = process.env.MINIO_DRAWINGS_BUCKET || 'halford-drawings';
const OUTPUTS_BUCKET = process.env.MINIO_OUTPUTS_BUCKET || 'halford-outputs';

async function putDrawing(projectId, fileName, localPath) {
  if (!useMinio) {
    return { storage_key: localPath };
  }
  const c = client();
  const key = `${projectId}/${Date.now()}_${fileName}`;
  await c.fPutObject(DRAWINGS_BUCKET, key, localPath);
  return { storage_key: key, bucket: DRAWINGS_BUCKET };
}

async function getDrawingTo(storageKey, localPath) {
  if (!useMinio) return storageKey;
  const c = client();
  await c.fGetObject(DRAWINGS_BUCKET, storageKey, localPath);
  return localPath;
}

async function putOutput(projectId, fileName, localPath) {
  if (!useMinio) {
    return { storage_key: localPath, public_url: `/output/${projectId}/${fileName}` };
  }
  const c = client();
  const key = `${projectId}/${fileName}`;
  await c.fPutObject(OUTPUTS_BUCKET, key, localPath);
  const url = await c.presignedGetObject(OUTPUTS_BUCKET, key, 7 * 24 * 60 * 60);
  return { storage_key: key, bucket: OUTPUTS_BUCKET, public_url: url };
}

module.exports = { useMinio, putDrawing, getDrawingTo, putOutput };
