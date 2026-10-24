import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { AppError, invariant } from './errors.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const MAX_VIDEO = 2 * 1024 ** 3;
const MAX_IMAGE = 20 * 1024 ** 2;

export function receiveUpload(request, directory) {
  return new Promise((resolve, reject) => {
    let parser;
    // Busboy emits partsLimit as soon as the limit is reached, even with no extra part.
    // Six parts are legitimate (four fields + two files), so the rejection gate is seven.
    try { parser = Busboy({ headers: request.headers, limits: { files: 2, fields: 4, parts: 7, fileSize: MAX_VIDEO, fieldSize: 2048 } }); }
    catch { reject(new AppError('请选择视频和替换图片。')); return; }
    const fields = {}, files = {}, writes = [];
    let failure = null;
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || !['mode', 'model', 'target', 'title'].includes(name) || name in fields) failure = new AppError('表单字段过长或不正确。');
      else fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (!['video', 'image'].includes(name) || files[name]) { failure = new AppError('只支持一个视频和一张替换图片。'); stream.resume(); return; }
      const extension = path.extname(info.filename).toLowerCase();
      if (!(name === 'video' ? VIDEO_EXT : IMAGE_EXT).has(extension)) { failure = new AppError(name === 'video' ? '视频请使用 MP4、MOV、MKV、WebM 或 AVI。' : '图片请使用 JPG、PNG、WebP 或 BMP。'); stream.resume(); return; }
      const filename = (name === 'video' ? 'source' : 'original-reference') + extension;
      const entry = files[name] = { filename, name: path.basename(info.filename).slice(0, 200), bytes: 0 };
      const output = createWriteStream(path.join(directory, filename), { flags: 'wx' });
      const bounded = new Transform({ transform(chunk, encoding, callback) {
        entry.bytes += chunk.length;
        if (entry.bytes > (name === 'video' ? MAX_VIDEO : MAX_IMAGE)) {
          failure = new AppError(name === 'video' ? '视频文件不能超过 2 GB。' : '图片文件不能超过 20 MB。', 413);
          callback();
        } else callback(null, chunk);
      } });
      stream.on('limit', () => { failure = new AppError('视频文件不能超过 2 GB。', 413); });
      writes.push(pipeline(stream, bounded, output).catch(error => { failure ||= error instanceof AppError ? error : new AppError('上传中断或磁盘不可写。', 400); }));
    });
    for (const event of ['partsLimit', 'fieldsLimit', 'filesLimit']) parser.on(event, () => { failure = new AppError('上传内容超过限制。'); });
    parser.on('error', async () => { await Promise.all(writes); reject(failure || new AppError('上传内容不完整。')); });
    request.on('aborted', () => parser.destroy(new Error('aborted')));
    parser.on('close', async () => {
      await Promise.all(writes);
      if (failure) { reject(failure); return; }
      try {
        invariant(files.video?.bytes && files.image?.bytes, '请同时上传视频与替换图片。');
        resolve({ fields, files });
      } catch (error) { reject(error); }
    });
    request.pipe(parser);
  });
}
