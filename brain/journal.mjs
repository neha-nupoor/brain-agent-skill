import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
const MAX_AGE = 5 * 60 * 1000;
const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export class Journal {
  constructor({ home, remote, branch = 'main', git = execute, now = Date.now }) {
    this.remote = remote;
    this.branch = branch;
    this.git = git;
    this.now = now;
    const identity = createHash('sha256').update(`${remote || 'disabled'}\n${branch}`).digest('hex').slice(0, 20);
    this.root = join(home, 'journals', identity);
    this.clone = join(this.root, 'checkout');
    this.statePath = join(this.root, 'state.json');
    this.lockPath = join(this.root, 'refresh.lock');
  }
  async command(args) {
    return (await this.git('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], {
      timeout: 15000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })).stdout.trim();
  }
  async saved() {
    try { const value = JSON.parse(await readFile(this.statePath, 'utf8')); return sha.test(value.commitSha) && Number.isFinite(Date.parse(value.lastSuccessfulSync)) ? value : null; }
    catch { return null; }
  }
  result(saved, freshness, reason) {
    return { commitSha: saved?.commitSha ?? null, lastSuccessfulSync: saved?.lastSuccessfulSync ?? null, freshness, ...(reason ? { reason } : {}) };
  }
  async refresh({ force = false } = {}) {
    let saved = await this.saved();
    if (!this.remote) return this.result(saved, 'degraded', 'journal_not_configured');
    if (!force && saved && this.now() - Date.parse(saved.lastSuccessfulSync) < MAX_AGE) return this.result(saved, 'fresh');
    let locked = false;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      // Atomic local ownership only. A crashed lock is recovered explicitly; never steal a live lock.
      try { await writeFile(this.lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true; }
      catch (error) { if (error.code === 'EEXIST') return this.result(saved, saved ? 'stale' : 'degraded', 'refresh_in_progress_or_interrupted'); throw error; }
      saved = await this.saved();
      if (!force && saved && this.now() - Date.parse(saved.lastSuccessfulSync) < MAX_AGE) return this.result(saved, 'fresh');
      let exists = true;
      try { await stat(join(this.clone, '.git')); } catch { exists = false; }
      if (!exists) await this.command(['clone', '--single-branch', '--branch', this.branch, '--', this.remote, this.clone]);
      else {
        const origin = await this.command(['-C', this.clone, 'remote', 'get-url', 'origin']);
        const branch = await this.command(['-C', this.clone, 'branch', '--show-current']);
        if (origin !== this.remote || branch !== this.branch) throw new Error('Unexpected clone identity');
        if (await this.command(['-C', this.clone, 'status', '--porcelain'])) throw new Error('Dirty journal checkout');
        const current = await this.command(['-C', this.clone, 'rev-parse', 'HEAD']);
        // Local commits, including fast-forwardable ones, are not authorized projections.
        if (saved && current !== saved.commitSha) throw new Error('Journal revision changed outside refresh');
        await this.command(['-C', this.clone, 'pull', '--ff-only', 'origin', this.branch]);
      }
      const commitSha = await this.command(['-C', this.clone, 'rev-parse', 'HEAD']);
      if (!sha.test(commitSha)) throw new Error('Invalid journal revision');
      const next = { commitSha, lastSuccessfulSync: new Date(this.now()).toISOString() };
      await writeFile(`${this.statePath}.${process.pid}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${this.statePath}.${process.pid}.tmp`, this.statePath);
      return this.result(next, 'fresh');
    } catch { return this.result(saved, 'degraded', 'journal_sync_failed'); }
    finally { if (locked) await unlink(this.lockPath).catch(() => {}); }
  }
  async files(revision) {
    if (!revision || !sha.test(revision)) return [];
    const tree = await this.command(['-C', this.clone, 'ls-tree', '-r', revision]);
    return tree.split('\n').flatMap(line => {
      const entry = line.match(/^100(?:644|755) blob [a-f0-9]+\t(.+\.md)$/);
      const canonical = /^journal\/\d{4}-(?:\d{2}-\d{2}|W\d{2})\.md$/;
      const legacy = /^(?:daily|weekly)\/[A-Za-z0-9_./-]+\.md$/;
      return entry && (canonical.test(entry[1]) || legacy.test(entry[1])) ? [entry[1]] : [];
    });
  }
  async read(path, source = null) {
    source ||= await this.refresh();
    const files = await this.files(source.commitSha);
    if (!files.includes(path)) throw new Error('Only committed daily/weekly journal Markdown is readable.');
    // Read the last-good Git object, never the mutable worktree or symlink target.
    return { path, text: await this.command(['-C', this.clone, 'show', `${source.commitSha}:${path}`]), source };
  }
  async search(query, limit = 20) {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('A bounded nonempty query and limit 1–100 are required.');
    const source = await this.refresh();
    const results = [];
    for (const path of await this.files(source.commitSha)) {
      const value = await this.read(path, source);
      const lines = value.text.split('\n');
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (lines[i].toLocaleLowerCase().includes(query.toLocaleLowerCase())) results.push({ path, line: i + 1, text: lines[i] });
      }
      if (results.length === limit) break;
    }
    return { results, source };
  }
  async recoverLock() {
    const pid = Number(await readFile(this.lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid lock; inspect it manually.');
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') { await unlink(this.lockPath); return { recovered: true }; }
      throw new Error('Cannot verify lock owner.');
    }
    throw new Error('Refresh owner is still running; stop it before recovering.');
  }
}
