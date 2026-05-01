// Job queue. Uses BullMQ (Redis-backed) when REDIS_URL is set, otherwise
// runs jobs inline in the request handler (dev mode).

const useRedis = !!process.env.REDIS_URL;
let _queue = null, _worker = null;

const aps = require('./aps');
const claude = require('./claude');

function url() { return process.env.REDIS_URL; }

function queue() {
  if (!useRedis) return null;
  if (_queue) return _queue;
  const { Queue } = require('bullmq');
  const u = new URL(url());
  _queue = new Queue('halford-drawings', {
    connection: { host: u.hostname, port: parseInt(u.port || '6379'), password: u.password || undefined },
  });
  return _queue;
}

async function enqueueDrawing({ projectId, drawingId, name, localPath }, save) {
  if (useRedis) {
    await queue().add('process-drawing', { projectId, drawingId, name, localPath });
  } else {
    // inline fallback — same body as the worker below
    processInline({ projectId, drawingId, name, localPath }, save).catch(e => console.error(e));
  }
}

async function processInline({ projectId, drawingId, name, localPath }, save) {
  const project = await save.load(projectId);
  const drawing = project.drawings.find(d => d.id === drawingId);
  if (!drawing) return;
  try {
    drawing.status = 'processing';
    await save.write(project);
    const result = await aps.processDrawing(projectId, name, localPath, async (stage) => {
      drawing.aps_stage = stage;
      await save.write(project);
    });
    drawing.urn = result.urn;
    drawing.properties = claude.compressProperties(result.properties, name);
    drawing.status = 'parsed';
  } catch (e) {
    drawing.status = 'failed';
    drawing.error = e.message;
  }
  await save.write(project);
}

function startWorker(save) {
  if (!useRedis || _worker) return;
  const { Worker } = require('bullmq');
  const u = new URL(url());
  _worker = new Worker('halford-drawings', async job => {
    if (job.name === 'process-drawing') {
      await processInline(job.data, save);
    }
  }, {
    connection: { host: u.hostname, port: parseInt(u.port || '6379'), password: u.password || undefined },
    concurrency: 2,
  });
  _worker.on('failed', (job, err) => console.error('queue job failed', job?.id, err.message));
}

module.exports = { useRedis, enqueueDrawing, startWorker };
