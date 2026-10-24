export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function invariant(value, message, status = 400) {
  if (!value) throw new AppError(message, status);
}

export function safeError(error) {
  if (['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'ENOENT', 'EIO'].includes(error?.code)) return `本地文件操作未完成（${error.code}），请检查文件占用、磁盘空间和权限后恢复任务。`;
  return error instanceof AppError ? error.message : '本地处理未完成，请检查磁盘空间、文件权限与运行环境后恢复任务。';
}
