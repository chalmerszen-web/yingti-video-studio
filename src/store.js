import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'queue.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created TEXT NOT NULL, body TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created TEXT NOT NULL, body TEXT NOT NULL)');
  }
  create(job) {
    this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?)').run(job.id, job.created, JSON.stringify(job));
    return job;
  }
  get(id) {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id = ?').get(id);
    if (!row) throw new AppError('任务不存在。', 404);
    return JSON.parse(row.body);
  }
  list() {
    return this.db.prepare('SELECT body FROM jobs ORDER BY created ASC, id ASC').all().map(row => JSON.parse(row.body));
  }
  update(id, change) {
    const job = this.get(id);
    change(job);
    job.updated = new Date().toISOString();
    this.db.prepare('UPDATE jobs SET body = ? WHERE id = ?').run(JSON.stringify(job), id);
    return job;
  }
  event(id, message) {
    return this.update(id, job => {
      job.events.push({ at: new Date().toISOString(), message });
      job.events = job.events.slice(-200);
    });
  }
  close() { this.db.close(); }
  createProject(project) {
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(project.id, project.created, JSON.stringify(project));
    return project;
  }
  project(id) {
    const row = this.db.prepare('SELECT body FROM projects WHERE id = ?').get(id);
    if (!row) throw new AppError('项目不存在。', 404);
    return JSON.parse(row.body);
  }
  projects() { return this.db.prepare('SELECT body FROM projects ORDER BY created DESC').all().map(row => JSON.parse(row.body)); }
  updateProject(id, change) {
    const project = this.project(id); change(project); project.updated = new Date().toISOString();
    this.db.prepare('UPDATE projects SET body = ? WHERE id = ?').run(JSON.stringify(project), id);
    return project;
  }
}

export function publicProject(project) {
  const { keyHash, ...visible } = project;
  return { ...visible, analysis: { ...project.analysis, windows: project.analysis.windows.map(({ responseFile, ...part }) => part) } };
}

export function publicJob(job) {
  const { keyHash, ...visible } = job;
  return {
    ...visible,
    segments: job.segments.map(({ affinity, idempotencyKey, ...segment }) => segment),
    progress: job.state === 'completed' ? 100 : Math.min(97, Math.round(job.segments.filter(s => s.state === 'completed').length / job.segments.length * 95)),
  };
}
