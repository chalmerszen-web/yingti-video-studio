import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, invariant } from './errors.js';

const extensions = {
  video: ['.mp4', '.mov', '.mkv', '.webm', '.avi'],
  image: ['.jpg', '.jpeg', '.png', '.bmp', '.webp'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
};

export function studioUpload(request, directory, { kind = 'video', count = 1, fields: allowedFields = ['title'], maxFieldBytes = 2048 } = {}) {
  return new Promise((resolve, reject) => {
    const maxBytes = kind === 'video' ? 2 * 1024 ** 3 : 20 * 1024 ** 2;
    let parser;
    try { parser = Busboy({ headers: request.headers, limits: { files: count, fields: allowedFields.length, parts: count + allowedFields.length + 1, fileSize: maxBytes, fieldSize: maxFieldBytes } }); }
    catch { reject(new AppError('请选择需要导入的文件。')); return; }
    const files = [], fields = {}, writes = [];
    let failure;
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || !allowedFields.includes(name) || Object.hasOwn(fields, name)) failure = new AppError('导入字段不正确。');
      else fields[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || files.length >= count) { failure = new AppError('导入文件数量不正确。'); stream.resume(); return; }
      const extension = path.extname(info.filename).toLowerCase();
      if (!extensions[kind].includes(extension)) { failure = new AppError('不支持这种文件格式：' + extensions[kind].join('、')); stream.resume(); return; }
      const item = { file: randomUUID() + extension, name: path.basename(info.filename).slice(0, 200), bytes: 0 };
      files.push(item);
      const bounded = new Transform({ transform(chunk, encoding, callback) {
        item.bytes += chunk.length;
        if (item.bytes > maxBytes) { failure = new AppError(kind === 'video' ? '视频不能超过 2 GB。' : '素材不能超过 20 MB。', 413); callback(); }
        else callback(null, chunk);
      } });
      stream.on('limit', () => { failure = new AppError('文件超过容量限制。', 413); });
      writes.push(pipeline(stream, bounded, createWriteStream(path.join(directory, item.file), { flags: 'wx' })).catch(() => { failure ||= new AppError('文件上传中断或磁盘不可写。'); }));
    });
    for (const event of ['partsLimit', 'fieldsLimit', 'filesLimit']) parser.on(event, () => { failure = new AppError('导入内容超过数量限制。'); });
    request.on('aborted', () => parser.destroy(new Error('aborted')));
    parser.on('error', async () => { await Promise.all(writes); reject(failure || new AppError('上传未完成。')); });
    parser.on('close', async () => {
      await Promise.all(writes);
      try { if (failure) throw failure; invariant(files.length && files.every(f => f.bytes), '请选择有效的文件。'); resolve({ files, fields }); }
      catch (error) { reject(error); }
    });
    request.pipe(parser);
  });
}
