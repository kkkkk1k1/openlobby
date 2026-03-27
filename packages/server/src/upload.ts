import type { FastifyInstance } from 'fastify';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export async function registerUploadRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    // Get cwd from the query string
    const cwd = (request.query as { cwd?: string }).cwd;
    if (!cwd) {
      return reply.status(400).send({ error: 'Missing cwd query parameter' });
    }

    // Collect file buffer
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of data.file) {
      size += chunk.length;
      if (size > MAX_FILE_SIZE) {
        return reply.status(413).send({ error: 'File too large (max 10MB)' });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Save to <cwd>/.openlobby-cache/
    const cacheDir = join(cwd, '.openlobby-cache');
    mkdirSync(cacheDir, { recursive: true });

    const ext = extname(data.filename);
    const savedName = `${randomUUID()}${ext}`;
    const savedPath = join(cacheDir, savedName);
    writeFileSync(savedPath, buffer);

    return {
      path: savedPath,
      filename: data.filename,
      size: buffer.length,
      mimetype: data.mimetype,
    };
  });
}
