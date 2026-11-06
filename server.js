// Agent Hub — локальная среда, где несколько ИИ-агентов (Gemini/Antigravity-аккаунты, Claude, Codex)
// работают вместе над проектами, общаются в общем чате и подчиняются лидеру.
// Без зависимостей: только Node.js >= 18.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');

// Внутри собранного .exe (Node SEA) интерфейс берётся из встроенного ресурса, а данные лежат рядом с .exe.
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
const PORT = Number(process.env.PORT || 4777);
const ROOT = sea ? path.dirname(process.execPath) : __dirname;
const EMBEDDED = require.main !== module;            // запущен внутри приложения Electron
const DATA = process.env.AGENT_HUB_DATA || path.join(ROOT, 'data');
const PROJECTS_DIR = process.env.AGENT_HUB_PROJECTS || path.join(ROOT, 'workspaces');
const HIDE = { windowsHide: true };
// встроенный tar Windows (bsdtar): умеет zip; tar из Git/MSYS принял бы «C:» за сетевой адрес
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
// у .exe нет консоли — пишем лог в файл
if (sea || EMBEDDED) { const lf = path.join(DATA, 'agent-hub.log'); fs.mkdirSync(path.dirname(lf), { recursive: true }); const w = (...a) => { try { fs.appendFileSync(lf, new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {} }; console.log = console.error = console.warn = w; }
const NO_WINDOW = EMBEDDED || process.argv.includes('--no-window') || !!process.env.AGENT_HUB_NO_WINDOW;
const STATE_FILE = path.join(DATA, 'state.json');
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- провайдеры
// Каждый провайдер: как изолировать аккаунт (env), как вызвать без интерфейса (prompt идёт через stdin),
// как открыть окно входа в аккаунт.
const PROVIDERS = {
  gemini: {
    label: 'Gemini CLI (Google-аккаунт / Antigravity)',
    bin: 'gemini',
    install: 'npm i -g @google/gemini-cli',
    env: (dir) => ({ GEMINI_CLI_HOME: dir, HOME: dir, USERPROFILE: dir }),
    args: (a, o = {}) => [...(a.model ? ['-m', a.model] : []), ...(o.readOnly ? ['--approval-mode', 'plan'] : a.autonomy === 'full' ? ['--yolo'] : ['--approval-mode', 'auto_edit'])],
    // вход через Google: заранее выбираем способ «Login with Google», первый запрос сам откроет страницу входа
    prepareLogin: (dir) => {
      const g = path.join(dir, '.gemini'); fs.mkdirSync(g, { recursive: true });
      const f = path.join(g, 'settings.json');
      let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      s.selectedAuthType = 'oauth-personal';
      s.security = { ...(s.security || {}), auth: { ...((s.security || {}).auth || {}), selectedType: 'oauth-personal' } };
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    },
    loginArgs: ['-p', 'ok'],   // без пробелов: аргументы идут через shell
    logout: (dir) => { for (const n of ['oauth_creds.json', 'google_accounts.json']) fs.rmSync(path.join(dir, '.gemini', n), { force: true }); },
    status: async (dir) => {
      const creds = path.join(dir, '.gemini', 'oauth_creds.json');
      if (!fs.existsSync(creds)) return { loggedIn: false };
      let account = '';
      try { account = JSON.parse(fs.readFileSync(path.join(dir, '.gemini', 'google_accounts.json'), 'utf8')).active || ''; } catch {}
      return { loggedIn: true, account };
    },
  },
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    install: 'npm i -g @anthropic-ai/claude-code',
    env: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
    args: (a, o = {}) => ['-p', ...(a.model ? ['--model', a.model] : []),
      ...(o.readOnly ? ['--permission-mode', 'plan'] : a.autonomy === 'full' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits'])],
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    status: async (dir, env) => {
      const r = await runCapture('claude', ['auth', 'status', '--json'], env, 20000);
      try {
        const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
        return { loggedIn: !!j.loggedIn, account: j.email || j.account?.email || j.orgName || '' };
      } catch { return { loggedIn: false }; }
    },
  },
  codex: {
    label: 'OpenAI Codex CLI',
    bin: 'codex',
    install: 'npm i -g @openai/codex',
    env: (dir) => ({ CODEX_HOME: dir }),
    args: (a, o = {}) => ['exec', '--skip-git-repo-check', ...(a.model ? ['-m', a.model] : []),
      ...(o.readOnly ? ['--sandbox', 'read-only'] : a.autonomy === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']),
      // без elevated-песочницы на Windows workspace-write молча превращается в read-only
      ...(process.platform === 'win32' && a.autonomy !== 'full' ? ['-c', 'windows.sandbox=elevated'] : []), '-'],
    loginArgs: ['login'],
    logoutArgs: ['logout'],
    status: async (dir, env) => {
      const r = await runCapture('codex', ['login', 'status'], env, 20000);
      const text = stripAnsi(r.out + r.err);
      return { loggedIn: r.code === 0 && !/not logged in/i.test(text), account: (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0] };
    },
  },
  custom: {
    label: 'Своя команда',
    bin: null, install: '', models: [],
    env: (dir) => ({ AGENT_HOME: dir }),
    args: () => [],
  },
  demo: {
    label: 'Демо (без аккаунта, для проверки)',
    bin: null, install: '', models: ['demo'], env: () => ({}), args: () => [],
  },
};

// запуск скрытого процесса с захватом вывода
function runCapture(cmd, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { env, shell: true, ...HIDE }); } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end();
    const t = setTimeout(() => { killTree(child); }, timeoutMs);
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => { clearTimeout(t); if (!done) { done = true; resolve({ code, out, err }); } });
  });
}

// ---------------------------------------------------------------- состояние
const uid = () => crypto.randomBytes(5).toString('hex');
let state = { agents: [], projects: [], leaderId: null, settings: { maxLeaderRounds: 6, maxCalls: 40, maxParallel: 4, timeoutMin: 20, historyLimit: 30 } };
if (fs.existsSync(STATE_FILE)) {
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { console.error('state.json повреждён, начинаю заново', e.message); }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)), 200);
}
// перенос: если папка проекта по умолчанию осталась на старом месте приложения — переводим её сюда
for (const p of state.projects) {
  const legacy = p.workspace;
  if (!p.workspaceRel && legacy && !legacy.startsWith(PROJECTS_DIR) && /[\\/](dist|agent-hub)[\\/]workspaces[\\/][^\\/]+$/i.test(legacy)) p.workspaceRel = path.basename(legacy);
  if (p.workspaceRel) {
    const target = path.join(PROJECTS_DIR, path.basename(p.workspaceRel));
    try { if (legacy && legacy !== target && fs.existsSync(legacy) && !fs.existsSync(target)) fs.cpSync(legacy, target, { recursive: true }); } catch {}
    p.workspace = target; fs.mkdirSync(target, { recursive: true });
  }
}
state.skills = state.skills || [];
state.mcp = state.mcp || [];
for (const p of state.projects) { p.tasks = p.tasks || []; p.taskSeq = p.taskSeq || 0; if (p.discuss === undefined) p.discuss = false; if (p.git === undefined) p.git = true; }
if (!state.projects.length) {
  state.projects.push(newProject('Мой первый проект'));
}
function newProject(name, workspace) {
  const id = uid();
  const rel = workspace ? null : (slug(name) || id);
  const ws = workspace || path.join(PROJECTS_DIR, rel);
  fs.mkdirSync(ws, { recursive: true });
  return { id, name, workspace: ws, workspaceRel: rel, goal: '', messages: [], tasks: [], taskSeq: 0, discuss: false, git: true, createdAt: Date.now() };
}
function slug(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40); }
const safeModel = (m) => String(m || '').trim().replace(/[^\w.\-:/@\[\]]/g, '');
const agentById = (id) => state.agents.find((a) => a.id === id);
const projectById = (id) => state.projects.find((p) => p.id === id);

// ---------------------------------------------------------------- SSE
const clients = new Set();
function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}
function publicState() {
  return {
    ...state,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, models: modelsOf(k), install: v.install, installed: isInstalled(k), canLogin: !!v.loginArgs }])),
    runtime: Object.fromEntries(state.projects.map((p) => [p.id, runtimeInfo(p.id)])),
    paths: { data: DATA, projects: PROJECTS_DIR }, isApp: EMBEDDED,
    auth: authStatus, authBusy: [...authSessions.keys()], installing: [...installing],
    sync: syncPublic(),
    mcp: (state.mcp || []).map(redactMcp),
    agentStatus: Object.fromEntries(state.agents.map((a) => [a.id, busy.has(a.id) ? 'busy' : 'idle'])),
  };
}
const pushState = () => broadcast('state', publicState());

const installedCache = {};
function isInstalled(key) {
  const bin = PROVIDERS[key].bin;
  if (!bin) return true;
  if (installedCache[key] && Date.now() - installedCache[key].t < 30000) return installedCache[key].v;
  let v = false;
  try { execSync(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`, { stdio: 'ignore', ...HIDE }); v = true; } catch {}
  installedCache[key] = { v, t: Date.now() };
  return v;
}

// ---------------------------------------------------------------- чат
function addMessage(project, msg) {
  const m = { id: uid(), ts: Date.now(), ...msg };
  project.messages.push(m);
  if (project.messages.length > 2000) project.messages.splice(0, project.messages.length - 2000);
  save();
  broadcast('message', { projectId: project.id, message: m });
  return m;
}

// ================================================================ КОМАНДНАЯ РАБОТА
// Всё, что делает команду «одним мозгом»:
//  • общая память проекта  — .agenthub/MEMORY.md (читают все, дополняют все);
//  • доска задач           — project.tasks: исполнитель, статус, файлы, зависимости;
//  • история изменений     — теневой git в .agenthub/history: кто что поменял, откат шага;
//  • распределение файлов  — задачи с общими файлами не идут параллельно, чужие правки — предупреждение;
//  • обсуждение            — по желанию: сначала все предлагают подход (только чтение), лидер собирает план.

const STATUS_RU = { todo: 'ожидает', doing: 'в работе', review: 'на проверке', done: 'готово', blocked: 'проблема' };
const MAX_PROMPT_MEMORY = 15000;

// ---------------------------------------------------------------- разбор обращений
// Строка «@Имя: текст [файлы: a, b] [после #2]» открывает поручение до следующей такой строки.
function parseMentions(text, selfId, opts = {}) {
  const out = [];
  let cur = null, blank = false;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*[-*•]?\s*\**@([\p{L}\p{N}_.\-]+)\**\s*[:,—–-]?\s*(.*)$/u);
    if (m) {
      const name = m[1].toLowerCase();
      const all = name === 'all' || name === 'все' || name === 'всем';
      const named = state.agents.filter((a) => a.enabled && a.name.toLowerCase() === name);
      const targets = all ? state.agents.filter((a) => a.enabled && a.id !== selfId)
        : named.filter((a) => a.id !== selfId || opts.allowSelf);
      if (targets.length) { cur = { targets, text: [m[2]] }; out.push(cur); blank = false; continue; }
      if (named.length) { cur = null; continue; } // обращение к себе не продолжает чужое поручение
    }
    if (!line.trim()) { blank = true; if (cur) cur.text.push(line); continue; }
    // после пустой строки обычный абзац (не список и не отступ) завершает поручение
    if (blank && cur && !/^(\s+|\s*([-*•]|\d+[.)])\s)/.test(line)) cur = null;
    blank = false;
    if (cur) cur.text.push(line);
  }
  const res = [];
  for (const c of out) {
    let full = c.text.join('\n').trim();
    const files = [], deps = [];
    for (const f of full.matchAll(/\[(?:файлы|файл|files?)\s*:\s*([^\]]+)\]/giu)) files.push(...f[1].split(/[,;]\s*/).map((x) => x.trim().replace(/^[`'"]|[`'"]$/g, '')).filter(Boolean));
    for (const d of full.matchAll(/\[(?:после|after)\s*:?\s*([^\]]+)\]/giu)) deps.push(...d[1].split(/[,;]\s*|\s+/).map((x) => x.trim()).filter(Boolean));
    full = full.replace(/\[(?:файлы|файл|files?|после|after)\s*:?[^\]]*\]/giu, '').trim();
    // «#2 — сделать …»: номер в плане лидера, а не id задачи на доске
    const lm = full.match(/^\**#(\d+)\**\s*[—–:.)-]?\s*/);
    const label = lm ? Number(lm[1]) : null;
    if (lm) full = full.slice(lm[0].length);
    for (const t of c.targets) res.push({ agentId: t.id, task: full, files: [...new Set(files.map(normPath))], deps, label });
  }
  return res;
}
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const pathHits = (file, owned) => { const f = normPath(file), o = normPath(owned); return f === o || f.startsWith(o + '/') || o.startsWith(f + '/'); };

// ---------------------------------------------------------------- общая память
const hubDir = (project) => path.join(project.workspace, '.agenthub');
const memoryFile = (project) => path.join(hubDir(project), 'MEMORY.md');
function ensureMemory(project) {
  const f = memoryFile(project);
  if (fs.existsSync(f)) return f;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [
    `# Память проекта: ${project.name}`,
    '',
    '> Общая память команды агентов. Её читают все перед работой и дополняют после. Пишите кратко, не удаляйте чужие записи.',
    '',
    '## Цель', project.goal || '(уточняется)', '',
    '## Архитектура и структура', '(пока пусто — лидер описывает, как устроен проект и где что лежит)', '',
    '## План', '(лидер записывает итоговый план работ)', '',
    '## Принятые решения', '', '## Договорённости (стиль, правила, команды запуска)', '', '## Журнал', '',
  ].join('\n'), 'utf8');
  return f;
}
function readMemory(project) { try { return fs.readFileSync(ensureMemory(project), 'utf8'); } catch { return ''; } }

// ---------------------------------------------------------------- история изменений (теневой git)
// Отдельный git-каталог внутри .agenthub — не трогает собственный git пользователя.
let gitOk = null;
async function gitAvailable() {
  if (gitOk === null) gitOk = (await runCaptureNoShell('git', ['--version'])).code === 0;
  return gitOk;
}
const gitDir = (project) => path.join(hubDir(project), 'history');
function git(project, args) {
  return runCaptureNoShell('git', ['--git-dir', gitDir(project), '--work-tree', project.workspace,
    '-c', 'user.name=Agent Hub', '-c', 'user.email=agenthub@local', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false',
    '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd: project.workspace });
}
async function gitEnsure(project) {
  if (project.git === false || !(await gitAvailable())) return false;
  const gd = gitDir(project);
  if (fs.existsSync(path.join(gd, 'HEAD'))) return true;
  fs.mkdirSync(gd, { recursive: true });
  const r = await runCaptureNoShell('git', ['--git-dir', gd, 'init', '-q'], { cwd: project.workspace });
  if (r.code !== 0) return false;
  fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'info', 'exclude'), ['.agenthub/history/', '.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '.DS_Store', 'Thumbs.db', ''].join('\n'));
  await gitCommit(project, 'Начальное состояние проекта');
  return true;
}
async function gitCommit(project, message) {
  if (!(await gitEnsure(project))) return null;
  await git(project, ['add', '-A']);
  const st = await git(project, ['diff', '--cached', '--numstat']);
  if (st.code !== 0 || !st.out.trim()) return null;
  const files = st.out.trim().split('\n').map((l) => { const [a, d, ...p] = l.split('\t'); return { path: normPath(p.join('\t')), add: +a || 0, del: +d || 0 }; });
  const c = await git(project, ['commit', '-q', '--no-verify', '-m', message]);
  if (c.code !== 0) return null;
  const sha = (await git(project, ['rev-parse', '--short', 'HEAD'])).out.trim();
  return { sha, files: files.slice(0, 200), total: files.length, add: files.reduce((s, f) => s + f.add, 0), del: files.reduce((s, f) => s + f.del, 0) };
}
async function gitRecent(project, n = 8) {
  if (!(await gitEnsure(project))) return '';
  const r = await git(project, ['log', `-n${n}`, '--pretty=format:%h %s', '--stat=120,80', '--stat-count=12']);
  return r.code === 0 ? r.out.trim() : '';
}
async function gitRevert(project, sha) {
  if (!(await gitEnsure(project))) throw new Error('История изменений недоступна');
  await gitCommit(project, 'Состояние перед откатом');
  const r = await git(project, ['revert', '--no-edit', sha]);
  if (r.code !== 0) { await git(project, ['revert', '--abort']); throw new Error('Не удалось откатить: после этого шага файлы уже меняли. ' + r.out.slice(-300)); }
  return (await git(project, ['rev-parse', '--short', 'HEAD'])).out.trim();
}

// ---------------------------------------------------------------- доска задач
function newTask(project, { title, text, owner, files = [], deps = [], createdBy }) {
  project.tasks = project.tasks || [];
  project.taskSeq = (project.taskSeq || 0) + 1;
  const t = { id: project.taskSeq, title: (title || text || '').split('\n')[0].replace(/^[#*\s]+/, '').slice(0, 140) || 'Задача',
    text: text || title || '', owner, files, deps, status: 'todo', createdBy, createdAt: Date.now(), updatedAt: Date.now(), commits: [], changed: [] };
  project.tasks.push(t);
  return t;
}
const taskById = (project, id) => (project.tasks || []).find((t) => t.id === Number(id));
function setTask(project, t, status) { if (!t) return; t.status = status; t.updatedAt = Date.now(); }
function boardText(project) {
  const ts = (project.tasks || []).filter((t) => t.status !== 'done' || Date.now() - t.updatedAt < 6 * 3600e3).slice(-30);
  if (!ts.length) return '(задач пока нет)';
  return ts.map((t) => `#${t.id} [${STATUS_RU[t.status]}] ${agentById(t.owner)?.name || '?'} — ${t.title}` +
    (t.files.length ? ` (файлы: ${t.files.join(', ')})` : '') + (t.deps.length ? ` (после: ${t.deps.map((d) => '#' + d).join(', ')})` : '')).join('\n');
}

// ---------------------------------------------------------------- очередь и запуск
const busy = new Map();      // agentId -> { child, projectId }
const runs = new Map();      // projectId -> состояние работы
function getRun(pid) {
  if (!runs.has(pid)) runs.set(pid, { queue: [], running: new Map(), calls: 0, leaderRounds: 0, active: false, phase: 'work', userTask: '' });
  return runs.get(pid);
}
function runtimeInfo(pid) {
  const r = getRun(pid);
  return { active: r.active, phase: r.phase, queue: r.queue.map((q) => q.agentId), running: [...r.running.keys()], calls: r.calls, leaderRounds: r.leaderRounds };
}

function enqueue(project, job) {
  const r = getRun(project.id);
  const a = agentById(job.agentId);
  if (!a || !a.enabled) return;
  // лидеру — одна реплика в очереди: склеиваем поводы
  if (job.agentId === state.leaderId && !job.taskId) {
    const ex = r.queue.find((q) => q.agentId === job.agentId && !q.taskId && q.mode === job.mode);
    if (ex) { ex.task += `\n\n(ещё от ${job.from}): ${job.task}`; return; }
  }
  r.queue.push({ mode: 'work', ...job });
  r.active = true;
}

// поручения → задачи на доске (от лидера или пользователя) либо вопросы коллегам (от участников)
function dispatchMentions(project, text, fromAgent, fromName) {
  const isLeaderOrUser = !fromAgent || fromAgent.id === state.leaderId;
  const created = {}, labels = {};
  for (const m of parseMentions(text, fromAgent?.id || null, { allowSelf: isLeaderOrUser })) {
    if (isLeaderOrUser) {
      // «@Имя: #1 по-прежнему за тобой» — напоминание о существующей задаче, не новая
      const same = m.label && taskById(project, m.label);
      if (same && same.owner === m.agentId && same.status !== 'done' && !created[m.agentId]) { labels[m.label] = same.id; continue; }
      const deps = [];
      for (const d of m.deps) {
        if (/^#?\d+$/.test(d)) { const n = Number(d.replace('#', '')); deps.push(labels[n] || n); }
        else { const ag = state.agents.find((a) => '@' + a.name.toLowerCase() === d.toLowerCase() || a.name.toLowerCase() === d.toLowerCase()); if (ag && created[ag.id]) deps.push(created[ag.id]); }
      }
      const t = newTask(project, { text: m.task || text, owner: m.agentId, files: m.files, deps: deps.filter((x) => taskById(project, x)), createdBy: fromName });
      created[m.agentId] = t.id; if (m.label) labels[m.label] = t.id;
      enqueue(project, { agentId: m.agentId, task: m.task || text, from: fromName, taskId: t.id });
    } else if (m.agentId !== state.leaderId) { // отчёт лидеру — не отдельный ход, он и так проверит
      enqueue(project, { agentId: m.agentId, task: m.task, from: fromName, mode: 'help' });
    }
  }
  return Object.keys(created).length;
}

function startFromUser(project, text) {
  const r = getRun(project.id);
  r.calls = 0; r.leaderRounds = 0; r.phase = 'work'; r.userTask = text;
  ensureMemory(project);
  const leader = agentById(state.leaderId);
  if (parseMentions(text, null).length) dispatchMentions(project, text, null, 'Пользователь');
  else if (leader?.enabled) {
    const members = state.agents.filter((a) => a.enabled && a.id !== leader.id);
    if (project.discuss && members.length) {
      r.phase = 'discuss';
      addMessage(project, { from: 'system', text: `Этап обсуждения: ${members.map((m) => m.name).join(', ')} предлагают подход, затем ${leader.name} собирает общий план.` });
      for (const m of members) enqueue(project, { agentId: m.id, task: text, from: 'Пользователь', mode: 'discuss' });
    } else enqueue(project, { agentId: leader.id, task: text, from: 'Пользователь', mode: 'lead' });
  } else {
    for (const a of state.agents.filter((x) => x.enabled)) enqueue(project, { agentId: a.id, task: text, from: 'Пользователь' });
  }
  pump(project);
}

function runningFiles(project) {
  const r = getRun(project.id), files = [];
  for (const job of r.running.values()) { const t = job.taskId && taskById(project, job.taskId); if (t) files.push(...t.files); }
  return files;
}
function jobReady(project, job) {
  if (busy.has(job.agentId)) return false;
  const t = job.taskId && taskById(project, job.taskId);
  if (!t) return true;
  const depsOk = t.deps.every((d) => { const dt = taskById(project, d); return !dt || ['review', 'done', 'blocked'].includes(dt.status); });
  if (!depsOk) return false;
  const rf = runningFiles(project);
  return !t.files.some((f) => rf.some((o) => pathHits(f, o))); // общие файлы — по очереди
}

function pump(project) {
  const r = getRun(project.id);
  const S = state.settings;
  while (r.queue.length && r.running.size < S.maxParallel) {
    let idx = r.queue.findIndex((q) => jobReady(project, q));
    if (idx < 0 && r.running.size === 0) idx = r.queue.findIndex((q) => !busy.has(q.agentId)); // не допускаем вечного ожидания
    if (idx < 0) break;
    if (r.calls >= S.maxCalls) {
      addMessage(project, { from: 'system', text: `Достигнут лимит вызовов (${S.maxCalls}). Работа остановлена — напишите, чтобы продолжить.` });
      r.queue = []; break;
    }
    const job = r.queue.splice(idx, 1)[0];
    r.calls++;
    if (job.agentId === state.leaderId && job.mode !== 'discuss') r.leaderRounds++;
    r.running.set(job.agentId, job);
    const t = job.taskId && taskById(project, job.taskId);
    if (t) setTask(project, t, 'doing');
    runAgent(project, job).catch((e) => console.error('runAgent', e));
  }
  if (!r.queue.length && !r.running.size) r.active = false;
  save(); pushState();
}

function onAgentDone(project, agent, job, text, ok, changes) {
  const r = getRun(project.id);
  r.running.delete(agent.id);
  const t = job.taskId && taskById(project, job.taskId);
  if (t) {
    setTask(project, t, ok ? (agent.id === state.leaderId ? 'done' : 'review') : 'blocked');
    if (changes) { t.commits.push(changes.sha); t.changed = [...new Set([...t.changed, ...changes.files.map((f) => f.path)])].slice(0, 100); }
  }
  // правки в чужих файлах — предупреждаем
  if (changes) {
    const foreign = [];
    for (const f of changes.files) {
      const other = (project.tasks || []).find((x) => x.owner !== agent.id && ['todo', 'doing'].includes(x.status) && x.files.some((o) => pathHits(f.path, o)));
      if (other) foreign.push(`${f.path} (задача #${other.id}, ${agentById(other.owner)?.name})`);
    }
    if (foreign.length) addMessage(project, { from: 'system', text: `⚠ ${agent.name} изменил файлы, закреплённые за коллегами: ${foreign.slice(0, 5).join(', ')}` });
  }
  if (r.stopped) { pump(project); return; }

  const isLeader = agent.id === state.leaderId;
  const finished = isLeader && /\[(ГОТОВО|DONE)\]/i.test(text);
  if (isLeader && ok) {
    for (const m of text.matchAll(/\[(?:принято|принят|done|ok|готово)\s*#(\d+)\]/giu)) setTask(project, taskById(project, m[1]), 'done');
  }
  if (finished) {
    r.queue = [];
    for (const x of project.tasks || []) if (x.status === 'review') setTask(project, x, 'done');
    r.phase = 'work';
    addMessage(project, { from: 'system', text: '✅ Лидер отметил задачу как выполненную.' });
  } else if (ok && job.mode !== 'discuss') {
    dispatchMentions(project, text, agent, agent.name);
  }

  const leader = agentById(state.leaderId);
  if (!finished && leader?.enabled && !r.queue.length && r.running.size === 0) {
    if (r.phase === 'discuss') {
      r.phase = 'work';
      enqueue(project, { agentId: leader.id, from: 'system', mode: 'lead',
        task: `Команда обсудила задачу пользователя (предложения — в истории чата выше). Исходная задача:\n${r.userTask}\n\n` +
          `Собери из предложений единый план: запиши его в .agenthub/MEMORY.md (разделы «Архитектура и структура» и «План»), затем раздай задачи участникам с закреплёнными файлами и зависимостями.` });
    } else if (!isLeader || (job.taskId && (project.tasks || []).some((x) => x.status !== 'done'))) {
      if (r.leaderRounds < state.settings.maxLeaderRounds) {
        enqueue(project, { agentId: leader.id, from: 'system', mode: 'lead',
          task: 'Участники отчитались (см. историю чата, доску задач и последние изменения). Проверь результат в рабочей папке. Принятые задачи отметь [принято #N], доработки раздай через @Имя, а если всё готово — заверши строкой [ГОТОВО] с итогом для пользователя. Обнови MEMORY.md, если появились важные решения.' });
      } else {
        addMessage(project, { from: 'system', text: `Лидер исчерпал лимит раундов (${state.settings.maxLeaderRounds}). Напишите, чтобы продолжить.` });
      }
    }
  }
  pump(project);
}

function stopProject(project) {
  const r = getRun(project.id);
  r.queue = [];
  r.stopped = true;
  r.phase = 'work';
  for (const [, b] of busy) if (b.projectId === project.id) killTree(b.child);
  setTimeout(() => { r.stopped = false; }, 1500);
  addMessage(project, { from: 'system', text: '⏹ Остановлено пользователем.' });
  pushState();
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', ...HIDE }); } catch {} }
  else child.kill('SIGTERM');
}

// ---------------------------------------------------------------- промпт: общий контекст команды
async function buildPrompt(project, agent, job) {
  const isLeader = agent.id === state.leaderId;
  const team = state.agents.filter((a) => a.enabled).map((a) =>
    `- ${a.name} — ${PROVIDERS[a.provider]?.label || a.provider}, модель ${a.model || 'по умолчанию'}${a.id === state.leaderId ? ' [ЛИДЕР]' : ''}${a.role ? `; специализация: ${a.role}` : ''}`).join('\n');
  const hist = project.messages.slice(-state.settings.historyLimit).map((m) => {
    const who = m.from === 'user' ? 'Пользователь' : m.from === 'system' ? 'Система' : (agentById(m.agentId)?.name || m.name || m.from);
    const t = m.text.length > 4000 ? m.text.slice(0, 4000) + '\n…(обрезано)' : m.text;
    return `[${who}${m.taskId ? ` · задача #${m.taskId}` : ''}]: ${t}`;
  }).join('\n\n');
  let memory = readMemory(project);
  if (memory.length > MAX_PROMPT_MEMORY) memory = memory.slice(0, MAX_PROMPT_MEMORY) + '\n…(дальше — прочитай файл .agenthub/MEMORY.md целиком)';
  const recent = await gitRecent(project).catch(() => '');
  const t = job.taskId && taskById(project, job.taskId);
  const foreign = (project.tasks || []).filter((x) => x.owner !== agent.id && ['todo', 'doing'].includes(x.status) && x.files.length)
    .map((x) => `${x.files.join(', ')} → ${agentById(x.owner)?.name} (#${x.id})`);

  const syntax = `Как поручать: отдельной строкой «@Имя: что сделать [файлы: путь1, путь2] [после #N]».\n` +
    `  [файлы: …] — файлы/папки, которые закрепляешь за исполнителем (двое не должны править один файл одновременно);\n` +
    `  [после #N] или [после @Имя] — если задача ждёт результата другой. «@all: …» — всем.\n` +
    `Принять результат: «[принято #N]». Когда вся работа готова: строка «[ГОТОВО]» и итог для пользователя.`;
  let roleText;
  if (job.mode === 'discuss') {
    roleText = `Сейчас ЭТАП ОБСУЖДЕНИЯ: файлы НЕ меняй, только изучи проект и предложи. Ответь кратко: как бы ты решал задачу, какую часть возьмёшь на себя с учётом твоей специализации, какие файлы затронешь, риски и вопросы. Лидер соберёт предложения всех в один план.`;
  } else if (isLeader) {
    roleText = `Ты ЛИДЕР команды — координируешь общую работу над ОДНИМ проектом. Пойми цель, продумай архитектуру, разбей работу на задачи с чёткими границами и раздай участникам с учётом их специализаций и моделей. ` +
      `Опиши архитектуру и план в .agenthub/MEMORY.md, чтобы вся команда работала по одной схеме. Небольшие вещи можешь сделать сам.\n${syntax}`;
  } else if (job.mode === 'help') {
    roleText = `Коллега обратился к тебе с вопросом или просьбой. Помоги: ответь по существу, при необходимости поправь файлы (только в пределах своей зоны или того, о чём просят).`;
  } else {
    roleText = `Ты участник команды, которая вместе работает над ОДНИМ проектом. Выполни свою задачу прямо в рабочей папке, следуя общей архитектуре и договорённостям из памяти проекта. ` +
      `Правь только свои файлы; если нужно изменить чужой — попроси владельца через «@Имя: …». Если тебе нужно что-то от коллеги — тоже через @Имя. ` +
      `В конце коротко отчитайся: что сделано, какие файлы изменены, что осталось или мешает.`;
  }
  const memRule = job.mode === 'discuss' ? '' :
    `\nОбщая память: если ты принял важное решение, договорился о формате/интерфейсе или узнал что-то нужное команде — допиши 1–3 строки в .agenthub/MEMORY.md (нужный раздел или «Журнал»). Не удаляй чужие записи. Папку .agenthub/history не трогай.`;

  return [
    `Ты — агент "${agent.name}" в Agent Hub: несколько ИИ-агентов работают одной командой над общим проектом пользователя, общаются в общем чате и ведут общую память.`,
    roleText,
    agent.instructions ? `Личные инструкции: ${agent.instructions}` : '',
    skillsPrompt(agent),
    mcpPrompt(agent),
    memRule,
    `\n=== Команда ===\n${team}`,
    `\n=== Проект ===\n"${project.name}". Рабочая папка (текущая директория): ${project.workspace}` + (project.goal ? `\nЦель: ${project.goal}` : ''),
    `\n=== Общая память проекта (.agenthub/MEMORY.md) ===\n${memory || '(пусто)'}`,
    `\n=== Доска задач ===\n${boardText(project)}`,
    recent ? `\n=== Последние изменения файлов (кто что менял) ===\n${recent}\nПодробный дифф: git --git-dir=.agenthub/history --work-tree=. show <хеш>` : '',
    foreign.length && job.mode !== 'discuss' ? `\n=== Файлы, закреплённые за коллегами (не правь их) ===\n${foreign.join('\n')}` : '',
    `\n=== История общего чата ===\n${hist || '(пусто)'}`,
    t ? `\n=== Твоя задача #${t.id} (от ${job.from}) ===\n${job.task}` + (t.files.length ? `\nТвои файлы: ${t.files.join(', ')}` : '') :
      `\n=== ${job.mode === 'discuss' ? 'Задача для обсуждения' : 'Текущее задание'} (от ${job.from}) ===\n${job.task}`,
    `\nОтветь одним сообщением в чат на русском языке.`,
  ].filter(Boolean).join('\n');
}

async function runAgent(project, job) {
  const agent = agentById(job.agentId);
  const prov = PROVIDERS[agent.provider];
  const started = Date.now();
  broadcast('typing', { projectId: project.id, agentId: agent.id, on: true });
  busy.set(agent.id, { child: { exitCode: null, pid: 0 }, projectId: project.id });
  const r = getRun(project.id);

  // зафиксировать изменения, сделанные вне агентов, чтобы шаг агента был виден отдельно
  if (r.running.size === 1 && job.mode !== 'discuss') await gitCommit(project, 'Изменения вне агентов').catch(() => null);
  ensureMemory(project);
  const prompt = await buildPrompt(project, agent, job);

  const finish = async (text, ok, meta = {}) => {
    let changes = null;
    if (job.mode !== 'discuss') {
      const t = job.taskId && taskById(project, job.taskId);
      changes = await gitCommit(project, `${t ? `#${t.id} ` : ''}${agent.name}: ${(t?.title || String(text).split('\n')[0]).slice(0, 100)}`).catch(() => null);
    }
    busy.delete(agent.id);
    broadcast('typing', { projectId: project.id, agentId: agent.id, on: false });
    addMessage(project, { from: 'agent', agentId: agent.id, name: agent.name, text: text || '(пустой ответ)', ok, ms: Date.now() - started,
      taskId: job.taskId || null, mode: job.mode, ...(changes ? { changes } : {}), ...meta });
    onAgentDone(project, agent, job, text || '', ok, changes);
  };

  if (agent.provider === 'demo') {
    const fake = { exitCode: null, pid: 0 };
    busy.set(agent.id, { child: fake, projectId: project.id });
    setTimeout(() => {
      if (fake.exitCode !== null) return;
      fake.exitCode = 0;
      const isLeader = agent.id === state.leaderId;
      const members = state.agents.filter((a) => a.enabled && a.id !== agent.id);
      let text;
      if (job.mode === 'discuss') text = `Предлагаю взять на себя часть «${agent.role || 'общая'}». Затрону файл ${slug(agent.name)}.txt.`;
      else if (isLeader && !(project.tasks || []).some((x) => x.status === 'review')) {
        text = `План готов, записал в память. Распределяю работу:\n` + members.map((m, i) => `@${m.name}: часть ${i + 1} задачи «${job.task.slice(0, 50)}» [файлы: ${slug(m.name)}.txt]${i > 0 ? ` [после @${members[0].name}]` : ''}`).join('\n');
        fs.appendFileSync(memoryFile(project), `\n- План (демо): ${members.map((m) => m.name).join(', ')} делят задачу на части.\n`);
      } else if (isLeader) {
        const rv = (project.tasks || []).filter((x) => x.status === 'review').map((x) => `[принято #${x.id}]`).join(' ');
        text = `Проверил результаты: ${rv || 'всё на месте'}.\n[ГОТОВО] Итог: задача выполнена командой (демо-режим).`;
      } else {
        fs.writeFileSync(path.join(project.workspace, `${slug(agent.name)}.txt`), `Демо-результат от ${agent.name}\n${job.task}\n`);
        text = `Сделал свою часть. Создал файл ${slug(agent.name)}.txt.`;
      }
      finish(text, true);
    }, 1000 + Math.random() * 1200);
    return;
  }

  const profileDir = agent.profileDir || path.join(DATA, 'profiles', agent.id);
  try { syncSkills(agent); } catch (e) { console.error('skills sync', e.message); }
  try { syncMcp(agent); } catch (e) { console.error('mcp sync', e.message); }
  fs.mkdirSync(profileDir, { recursive: true });
  const env = { ...process.env, ...prov.env(profileDir), ...(agent.env || {}) };
  let cmd, args;
  if (agent.provider === 'custom') {
    cmd = String(agent.command || '').replace(/\{model\}/g, safeModel(agent.model));
    args = [];
    if (!cmd) return finish('❌ Для своей команды не указана команда запуска.', false);
  } else {
    cmd = prov.bin;
    args = [...prov.args({ ...agent, model: safeModel(agent.model) }, { readOnly: job.mode === 'discuss' }), ...mcpArgs(agent, job.mode === 'discuss')];
  }

  let child;
  try {
    child = spawn(cmd, args, { cwd: project.workspace, env, shell: true, windowsHide: true });
  } catch (e) {
    return finish(`❌ Не удалось запустить ${cmd}: ${e.message}`, false);
  }
  busy.set(agent.id, { child, projectId: project.id });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; broadcast('stream', { projectId: project.id, agentId: agent.id, chunk: d.toString() }); });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const timer = setTimeout(() => { err += `\n[таймаут ${state.settings.timeoutMin} мин]`; killTree(child); }, state.settings.timeoutMin * 60000);
  child.on('error', (e) => { err += e.message; });
  child.on('close', (code) => {
    clearTimeout(timer);
    const clean = stripAnsi(out).trim();
    if (code === 0 && clean) return finish(clean, true);
    const notInstalled = /is not recognized as|не является внутренней|command not found|ENOENT/i.test(err);
    let hint = '', needsUpdate = null;
    const all = err + out;
    if (notInstalled && prov.install) hint = `\nПохоже, программа не установлена — нажмите «Установить» у агента.`;
    else if (/or newer is required|claude update|please (update|upgrade)|upgrade (codex|gemini)|newer version|not supported by this version|does not support this model/i.test(all)) {
      hint = '\nПрограмма агента устарела для этой модели — нажмите «Обновить» ниже.'; needsUpdate = agent.provider;
    }
    else if (/mcp/i.test(all) && /fail|error|timed? ?out|не удалось/i.test(all) && mcpFor(agent).length) hint = '\nПохоже, не запустился MCP-сервер. Проверьте его кнопкой «Проверить» на вкладке «MCP» или выключите.';
    else if (/auth|login|credential|unauthori|401|403/i.test(err + out)) hint = '\nПохоже, аккаунт не авторизован — нажмите «Войти» у этого агента.';
    finish(`❌ Ошибка (код ${code}).${hint}\n${stripAnsi(err || out).trim().slice(-1500)}`, false, needsUpdate ? { needsUpdate } : {});
  });
}
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');


// ---------------------------------------------------------------- вход в аккаунты (внутри приложения)
// Команда входа запускается скрыто; её вывод (ссылки, коды) идёт в окно приложения,
// а если CLI просит вставить код — пользователь вводит его там же.
const authStatus = {};          // agentId -> { loggedIn, account, checking }
const authSessions = new Map(); // agentId -> child
const profileOf = (a) => a.profileDir || path.join(DATA, 'profiles', a.id);
const agentEnv = (a) => {
  const dir = profileOf(a); fs.mkdirSync(dir, { recursive: true });
  return { ...process.env, ...PROVIDERS[a.provider].env(dir), ...(a.env || {}) };
};

async function refreshAuth(a) {
  const prov = PROVIDERS[a.provider];
  if (!prov?.status) { delete authStatus[a.id]; return; }
  if (!isInstalled(a.provider) && a.provider !== 'gemini') { authStatus[a.id] = { loggedIn: false, notInstalled: true }; pushState(); return; }
  authStatus[a.id] = { ...(authStatus[a.id] || {}), checking: true }; pushState();
  try { authStatus[a.id] = await prov.status(profileOf(a), agentEnv(a)); }
  catch { authStatus[a.id] = { loggedIn: false }; }
  pushState();
}

function startLogin(a) {
  const prov = PROVIDERS[a.provider];
  if (!prov.loginArgs) throw new Error('Этому типу агента вход не нужен');
  if (!isInstalled(a.provider)) throw new Error('Сначала установите ' + prov.label);
  cancelLogin(a.id);
  const dir = profileOf(a);
  prov.prepareLogin?.(dir);
  const child = spawn(prov.bin, prov.loginArgs, { cwd: dir, env: agentEnv(a), shell: true, ...HIDE });
  authSessions.set(a.id, child);
  const emit = (chunk) => broadcast('auth', { agentId: a.id, chunk: stripAnsi(chunk) });
  emit(`Запускаю вход для «${a.name}»… Сейчас откроется страница входа в браузере.\n` +
       `Если открылся не тот аккаунт — выберите нужный или нажмите на ссылку ниже.\n\n`);
  // CLI иногда спрашивает подтверждение вида [Y/n] — отвечаем «да» сами
  const onOut = (d) => { const t = d.toString(); emit(t); if (/[[(]y\/n[\])]/i.test(t)) child.stdin.write('y\n'); };
  child.stdout.on('data', onOut);
  child.stderr.on('data', onOut);
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => killTree(child), 10 * 60000);
  child.on('error', (e) => emit('\nОшибка: ' + e.message));
  child.on('close', async (code) => {
    clearTimeout(timer);
    if (authSessions.get(a.id) === child) authSessions.delete(a.id);
    await refreshAuth(a);
    const st = authStatus[a.id] || {};
    broadcast('auth', { agentId: a.id, done: true, ok: !!st.loggedIn, account: st.account || '', code });
    if (a.provider === 'codex' && st.loggedIn) refreshModels('codex');
    syncSoon();
  });
  pushState();
}
function cancelLogin(agentId) {
  const c = authSessions.get(agentId);
  if (c) { authSessions.delete(agentId); killTree(c); }
}
async function logout(a) {
  const prov = PROVIDERS[a.provider];
  if (prov.logout) prov.logout(profileOf(a));
  if (prov.logoutArgs) await runCapture(prov.bin, prov.logoutArgs, agentEnv(a), 20000);
  await refreshAuth(a);
  syncSoon();
}

// ---------------------------------------------------------------- списки моделей
// Берём актуальный список прямо из установленных CLI, чтобы он обновлялся вместе с ними:
//  - Codex: `codex debug models` (каталог с сервера, зависит от аккаунта);
//  - Gemini CLI: официальный список VALID_GEMINI_MODELS внутри пакета;
//  - Claude Code: списка нет — алиасы (всегда последняя версия) + известные модели.
const modelCache = {}; // provider -> [{ id, label }]
const STATIC_MODELS = {
  claude: [
    { id: 'opus', label: 'Opus — последняя версия' },
    { id: 'sonnet', label: 'Sonnet — последняя версия' },
    { id: 'haiku', label: 'Haiku — последняя версия' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  ],
  gemini: [
    { id: 'auto', label: 'Авто — CLI сам выбирает модель' },
    { id: 'pro', label: 'Pro — лучшая Pro-модель' },
    { id: 'flash', label: 'Flash — быстрая' },
    { id: 'flash-lite', label: 'Flash Lite — самая быстрая' },
  ],
  demo: [{ id: 'demo', label: 'demo' }],
};
const modelsOf = (key) => modelCache[key] || STATIC_MODELS[key] || [];

let npmRootCache = null;
async function npmRoot() {
  if (npmRootCache) return npmRootCache;
  const r = await runCapture('npm', ['root', '-g'], process.env, 30000);
  npmRootCache = r.out.trim().split(/\r?\n/).pop() || null;
  return npmRootCache;
}

async function discoverGemini() {
  const root = await npmRoot();
  const dir = root && path.join(root, '@google', 'gemini-cli', 'bundle');
  if (!dir || !fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = src.match(/VALID_GEMINI_MODELS = [^[]*\[([^\]]*)\]/);
    if (!m) continue;
    const consts = {};
    for (const c of src.matchAll(/\b([A-Z0-9_]+) = "([^"]*)"/g)) consts[c[1]] = c[2];
    const ids = m[1].split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => (s.startsWith('"') ? s.slice(1, -1) : consts[s]))
      .filter((id) => id && id !== 'none');
    const uniq = [...new Set(ids)];
    if (!uniq.length) return null;
    return [...STATIC_MODELS.gemini, ...uniq.map((id) => ({ id, label: id }))];
  }
  return null;
}

async function discoverCodex() {
  // каталог зависит от аккаунта — берём профиль агента, у которого выполнен вход
  const a = state.agents.find((x) => x.provider === 'codex' && authStatus[x.id]?.loggedIn) || state.agents.find((x) => x.provider === 'codex');
  const env = a ? agentEnv(a) : { ...process.env, CODEX_HOME: path.join(DATA, 'profiles', '_models') };
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const r = await runCapture('codex', ['debug', 'models'], env, 30000);
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    const list = (j.models || []).filter((m) => m.visibility !== 'hide')
      .sort((x, y) => (x.priority ?? 99) - (y.priority ?? 99))
      .map((m) => ({ id: m.slug, label: m.display_name + (m.description ? ' — ' + m.description : '') }));
    return list.length ? list : null;
  } catch { return null; }
}

async function refreshModels(key) {
  const fn = { gemini: discoverGemini, codex: discoverCodex }[key];
  if (!fn || !isInstalled(key)) return;
  try { const list = await fn(); if (list) { modelCache[key] = list; pushState(); } }
  catch (e) { console.error('models', key, e.message); }
}
const refreshAllModels = () => Promise.all(['gemini', 'codex'].map(refreshModels));

// ---------------------------------------------------------------- установка CLI из приложения
const installing = new Set();
function installProvider(key, update = false) {
  const prov = PROVIDERS[key];
  if (!prov?.install) throw new Error('Для этого типа установка не нужна');
  if (installing.has(key)) return;
  installing.add(key); pushState();
  const pkg = prov.install.replace(/^npm i -g /, '') + '@latest';
  const child = spawn('npm', ['i', '-g', pkg], { shell: true, ...HIDE });
  const emit = (chunk) => broadcast('install', { provider: key, chunk: stripAnsi(chunk) });
  emit(`${update ? 'Обновляю' : 'Устанавливаю'} ${prov.label} (${pkg})… это может занять пару минут.\n`);
  child.stdout.on('data', (d) => emit(d.toString()));
  child.stderr.on('data', (d) => emit(d.toString()));
  child.stdin.end();
  child.on('error', (e) => emit('\nОшибка: ' + e.message + '\nПохоже, не установлен Node.js — скачайте его с nodejs.org.'));
  child.on('close', (code) => {
    installing.delete(key);
    delete installedCache[key];
    broadcast('install', { provider: key, done: true, ok: code === 0 && isInstalled(key) });
    npmRootCache = null; refreshModels(key);
    for (const a of state.agents.filter((x) => x.provider === key)) refreshAuth(a);
    pushState();
  });
}

// открыть ссылку в обычном браузере пользователя
function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Можно открывать только http(s)-ссылки');
  if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- скиллы
// Скилл = папка с SKILL.md (frontmatter name/description + инструкции) и любыми доп. файлами.
// Хранятся в data/skills/<id>. Каждому агенту копируются туда, где их ищет его программа:
//   Claude Code → <профиль>/skills,  Codex → <CODEX_HOME>/skills,  Gemini CLI → <профиль>/.gemini/skills.
// Для «своей команды» и демо текст скилла добавляется прямо в запрос.
const SKILLS_DIR = path.join(DATA, 'skills');
fs.mkdirSync(SKILLS_DIR, { recursive: true });
const MARK = '.agenthub-skill';
const skillById = (id) => state.skills.find((x) => x.id === id);

const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function skillSlug(s) {
  const t = String(s || '').toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('');
  return t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function uniqueSkillId(base) {
  let id = base || 'skill', n = 2;
  while (skillById(id)) id = `${base}-${n++}`;
  return id;
}

function parseSkillMd(text) {
  text = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = { name: '', description: '', extra: [], body: text };
  if (m) {
    meta.body = m[2];
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv && kv[1] === 'name') meta.name = kv[2].replace(/^["']|["']$/g, '').trim();
      else if (kv && kv[1] === 'description') meta.description = kv[2].replace(/^["']|["']$/g, '').trim();
      else meta.extra.push(line);
    }
  }
  if (!meta.description) {
    const first = meta.body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    meta.description = (first || 'Скилл').slice(0, 200);
  }
  return meta;
}
function buildSkillMd(name, description, body) {
  return `---\nname: ${name || 'skill'}\ndescription: ${String(description || '').replace(/\n/g, ' ')}\n---\n\n${body || ''}\n`;
}
// пишем SKILL.md в нормальном виде: name = id (так требуют CLI), без BOM, LF
function writeSkillMd(dir, meta, id) {
  const desc = String(meta.description || '').replace(/\s+/g, ' ').trim();
  const head = ['---', `name: ${id}`, `description: ${JSON.stringify(desc)}`, ...meta.extra.filter(Boolean), '---', ''];
  fs.writeFileSync(path.join(dir, 'SKILL.md'), head.join('\n') + meta.body.replace(/^\n+/, '\n'), { encoding: 'utf8' });
}
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === MARK) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function registerSkill(srcDir, meta, displayName, all, agents, filter) {
  const id = uniqueSkillId(skillSlug(meta.name || displayName) || 'skill');
  const dest = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dest, { recursive: true });
  if (srcDir) fs.cpSync(srcDir, dest, { recursive: true, ...(filter ? { filter } : {}) });
  writeSkillMd(dest, meta, id);
  const sk = { id, name: displayName || meta.name || id, description: meta.description, all: !!all, agents: (agents || []).filter((x) => agentById(x)), enabled: true, createdAt: Date.now() };
  state.skills.push(sk);
  return sk;
}
function importSkillText(content, displayName, all, agents) {
  const meta = parseSkillMd(content);
  if (displayName && !meta.name) meta.name = displayName;
  const sk = registerSkill(null, meta, displayName || meta.name, all, agents);
  save(); syncAllSkills(); pushState();
  return sk;
}

// загрузка: файлы .md, архивы .zip или целая папка (относительные пути сохраняются)
async function importUpload(files, all, agents) {
  if (!files.length) throw new Error('Нет файлов');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agenthub-skill-'));
  try {
    for (const f of files) {
      const rel = String(f.path || f.name || 'file').replace(/\\/g, '/').split('/').filter((x) => x && x !== '..' && x !== '.').join('/');
      const dest = path.join(tmp, rel);
      if (!dest.startsWith(tmp)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(f.data || '', 'base64'));
    }
    // распаковать архивы встроенным tar (Windows 10+ умеет zip)
    for (const z of listFiles(tmp).filter((p) => /\.(zip|skill)$/i.test(p))) {
      const zp = path.join(tmp, z), out = zp + '_unz';
      fs.mkdirSync(out, { recursive: true });
      const r = await runCaptureNoShell(TAR, ['-xf', zp, '-C', out]);
      if (r.code !== 0) throw new Error('Не удалось распаковать архив ' + path.basename(z));
      fs.rmSync(zp, { force: true });
    }
    const all_ = listFiles(tmp);
    const skillMds = all_.filter((p) => /(^|\/)SKILL\.md$/i.test(p));
    const added = [];
    if (skillMds.length) {
      for (const sm of skillMds) {
        const dir = path.join(tmp, path.dirname(sm));
        const meta = parseSkillMd(fs.readFileSync(path.join(tmp, sm), 'utf8'));
        const folderName = path.basename(dir) === path.basename(tmp) ? '' : path.basename(dir);
        if (!meta.name) meta.name = folderName;
        // вложенные скиллы импортируются отдельно — не копируем их внутрь родителя
        const subDirs = skillMds.filter((o) => o !== sm).map((o) => path.join(tmp, path.dirname(o))).filter((d) => d !== dir && d.startsWith(dir + path.sep));
        const filter = (src) => !subDirs.some((d) => src === d || src.startsWith(d + path.sep));
        added.push(registerSkill(dir, meta, meta.name || folderName, all, agents, filter));
      }
    } else {
      const mds = all_.filter((p) => /\.(md|markdown|txt)$/i.test(p));
      if (!mds.length) throw new Error('Не нашёл SKILL.md или .md-файлов. Скилл — это папка с SKILL.md или один .md-файл.');
      for (const md of mds) {
        const meta = parseSkillMd(fs.readFileSync(path.join(tmp, md), 'utf8'));
        if (!meta.name) meta.name = path.basename(md).replace(/\.\w+$/, '');
        added.push(registerSkill(null, meta, meta.name, all, agents));
      }
    }
    save(); syncAllSkills(); pushState();
    return { added };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function runCaptureNoShell(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    const c = spawn(cmd, args, { ...HIDE, ...opts });
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('error', (e) => resolve({ code: -1, out: e.message }));
    c.on('close', (code) => resolve({ code, out }));
  });
}

const NATIVE_SKILLS = { claude: (dir) => path.join(dir, 'skills'), codex: (dir) => path.join(dir, 'skills'), gemini: (dir) => path.join(dir, '.gemini', 'skills') };
const skillsFor = (agent) => state.skills.filter((sk) => sk.enabled && (sk.all || (sk.agents || []).includes(agent.id)));

function syncSkills(agent) {
  const target = NATIVE_SKILLS[agent.provider];
  if (!target) return;
  const dir = target(agent.profileDir || path.join(DATA, 'profiles', agent.id));
  fs.mkdirSync(dir, { recursive: true });
  const want = new Set(skillsFor(agent).map((s) => s.id));
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, MARK)) && !want.has(e.name)) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
  }
  for (const id of want) {
    const src = path.join(SKILLS_DIR, id), dest = path.join(dir, id);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, MARK))) continue; // не трогаем чужую папку с тем же именем
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, MARK), 'managed by Agent Hub\n');
  }
}
function syncAllSkills() { for (const a of state.agents) { try { syncSkills(a); } catch (e) { console.error('skills', a.name, e.message); } } }

function skillsPrompt(agent) {
  const list = skillsFor(agent);
  if (!list.length) return '';
  if (NATIVE_SKILLS[agent.provider]) {
    return `Тебе подключены скиллы (используй, когда подходят к задаче): ${list.map((s) => `${s.id} — ${s.description}`).join('; ')}.`;
  }
  return 'Твои скиллы (инструкции, которые нужно применять, когда они подходят):\n' + list.map((s) => {
    let body = ''; try { body = parseSkillMd(fs.readFileSync(path.join(SKILLS_DIR, s.id, 'SKILL.md'), 'utf8')).body; } catch {}
    return `### ${s.name}\n${s.description}\n${body.slice(0, 8000)}`;
  }).join('\n\n');
}


// ---------------------------------------------------------------- MCP-серверы (инструменты агентов)
// Один список серверов на всё приложение. Каждый выдаётся всем агентам или выбранным, и Agent Hub
// сам прописывает его программе агента:
//   Claude Code → --mcp-config <профиль>/agenthub-mcp.json,  Codex → блок в <CODEX_HOME>/config.toml,
//   Gemini CLI → mcpServers в <профиль>/.gemini/settings.json.
const MCP_PRESETS = [
  { key: 'playwright', name: 'playwright', title: 'Браузер (Playwright)', desc: 'Открывает сайты, кликает, заполняет формы, делает скриншоты.', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  { key: 'chrome-devtools', name: 'chrome-devtools', title: 'Chrome DevTools', desc: 'Отладка страниц: консоль, сеть, производительность.', type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
  { key: 'context7', name: 'context7', title: 'Context7 — документация', desc: 'Свежая документация библиотек и фреймворков по запросу.', type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  { key: 'sequential-thinking', name: 'sequential-thinking', title: 'Пошаговое мышление', desc: 'Помогает разбирать сложные задачи по шагам.', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  { key: 'memory', name: 'memory', title: 'Память (граф знаний)', desc: 'Долговременная память между сессиями: сущности и связи.', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { key: 'github', name: 'github', title: 'GitHub', desc: 'Репозитории, issues, pull requests. Нужен токен GitHub.', type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ВАШ_ТОКЕН' }, needs: 'token' },
];
const mcpById = (id) => state.mcp.find((x) => x.id === id);
const mcpName = (s) => String(s || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mcp';
const mcpFor = (agent) => state.mcp.filter((m) => m.enabled && (m.all || (m.agents || []).includes(agent.id)));
const WIN = process.platform === 'win32';
// npx/npm на Windows — это .cmd: программы агентов запускают сервер без оболочки, поэтому через cmd /c
function mcpLaunch(m) {
  const cmd = String(m.command || '').trim();
  if (WIN && /^(npx|npm|pnpm|pnpx|yarn|bunx|uvx|uv)(\.cmd)?$/i.test(cmd) || /\.(cmd|bat)$/i.test(cmd)) return { command: 'cmd', args: ['/c', cmd, ...(m.args || [])] };
  return { command: cmd, args: m.args || [] };
}
function normMcp(b, prev = {}) {
  const type = b.type === 'http' || (!b.command && b.url) ? 'http' : 'stdio';
  const kv = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [String(k).trim(), String(v)]).filter(([k]) => k));
  const m = { ...prev, name: mcpName(b.name ?? prev.name), title: String(b.title ?? prev.title ?? '').trim(), description: String(b.description ?? prev.description ?? '').trim(), type };
  if (type === 'stdio') {
    m.command = String(b.command ?? prev.command ?? '').trim();
    m.args = Array.isArray(b.args) ? b.args.map(String) : typeof b.args === 'string' ? splitArgs(b.args) : (prev.args || []);
    m.env = b.env !== undefined ? kv(b.env) : (prev.env || {});
    delete m.url; delete m.headers;
    if (!m.command) throw new Error('Укажите команду запуска сервера');
  } else {
    m.url = String(b.url ?? prev.url ?? '').trim();
    m.headers = b.headers !== undefined ? kv(b.headers) : (prev.headers || {});
    delete m.command; delete m.args; delete m.env;
    if (!/^https?:\/\//i.test(m.url)) throw new Error('Укажите адрес сервера (http:// или https://)');
  }
  return m;
}
// строка аргументов → массив (кавычки поддерживаются)
function splitArgs(s) {
  const out = []; let cur = '', q = null, has = false;
  for (const c of String(s)) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}
// секреты MCP (переменные окружения, заголовки, токены в аргументах и адресах) — только звёздочками
const MASK = '••••••';
const SECRET_FLAG = /(token|key|secret|pass|auth|cred|bearer)/i;
const looksSecret = (v) => /^(sk-|sk_|ghp_|gho_|github_pat_|xox[abp]-|AIza|ya29\.|eyJ)/.test(v) || /^[A-Za-z0-9_\-]{32,}$/.test(v);
const maskUrl = (u) => String(u || '').replace(/\/\/([^/@:]+):([^/@]+)@/, '//$1:' + MASK + '@').replace(/([?&][^=&]*(token|key|secret|pass|auth)[^=&]*=)[^&]+/gi, '$1' + MASK);
function redactMcp(m) {
  const r = { ...m };
  if (m.env) r.env = Object.fromEntries(Object.entries(m.env).map(([k, v]) => [k, v ? MASK : '']));
  if (m.headers) r.headers = Object.fromEntries(Object.entries(m.headers).map(([k, v]) => [k, /^(bearer|basic|token)\s+/i.test(v) ? v.split(/\s+/)[0] + ' ' + MASK : v ? MASK : '']));
  if (m.args) r.args = m.args.map((x, i) => (i > 0 && SECRET_FLAG.test(m.args[i - 1]) && /^--?/.test(m.args[i - 1])) || looksSecret(x) ? MASK : x.replace(/=(.+)$/, (all, val) => SECRET_FLAG.test(x.split('=')[0]) ? '=' + MASK : all)).map(maskUrl);
  if (m.url) r.url = maskUrl(m.url);
  return r;
}
// из формы приходят звёздочки там, где секрет не меняли — подставляем сохранённое значение
function unmaskMcp(cfg, prev) {
  const c = { ...cfg };
  const has = (v) => String(v || '').includes(MASK);
  if (c.env && prev.env) for (const [k, v] of Object.entries(c.env)) if (has(v)) c.env[k] = prev.env[k] ?? '';
  if (c.headers && prev.headers) for (const [k, v] of Object.entries(c.headers)) if (has(v)) c.headers[k] = prev.headers[k] ?? '';
  if (c.args !== undefined && prev.args) {
    const arr = Array.isArray(c.args) ? c.args : splitArgs(c.args);
    c.args = arr.map((x, i) => has(x) ? (prev.args[i] ?? '') : x);
  }
  if (has(c.url)) c.url = prev.url;
  return c;
}
function addMcp(b) {
  const m = normMcp(b);
  let name = m.name, n = 2;
  while (state.mcp.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${m.name}-${n++}`;
  const rec = { id: uid(), ...m, name, all: b.all !== false, agents: (b.agents || []).filter((x) => agentById(x)), enabled: b.enabled !== false, tools: null, createdAt: Date.now() };
  state.mcp.push(rec);
  return rec;
}

// --- запись конфигурации для каждой программы
const CLAUDE_MCP_FILE = (dir) => path.join(dir, 'agenthub-mcp.json');
const tomlStr = (s) => JSON.stringify(String(s));
const tomlKey = (k) => /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k);
const tomlTable = (o) => `{ ${Object.entries(o).map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(', ')} }`;
const BEGIN = '# >>> Agent Hub MCP (управляется приложением, не редактируйте)', END = '# <<< Agent Hub MCP';

function syncMcp(agent) {
  const dir = profileOf(agent);
  const list = mcpFor(agent);
  if (agent.provider === 'claude') {
    const f = CLAUDE_MCP_FILE(dir);
    if (!list.length) { fs.rmSync(f, { force: true }); return; }
    fs.mkdirSync(dir, { recursive: true });
    const servers = {};
    for (const m of list) {
      if (m.type === 'http') servers[m.name] = { type: 'http', url: m.url, ...(Object.keys(m.headers || {}).length ? { headers: m.headers } : {}) };
      else { const l = mcpLaunch(m); servers[m.name] = { type: 'stdio', command: l.command, args: l.args, ...(Object.keys(m.env || {}).length ? { env: m.env } : {}) }; }
    }
    fs.writeFileSync(f, JSON.stringify({ mcpServers: servers }, null, 2));
  } else if (agent.provider === 'codex') {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'config.toml');
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch {}
    const re = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`, 'g');
    txt = txt.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    if (list.length) {
      const blocks = list.map((m) => {
        const lines = [`[mcp_servers.${tomlKey(m.name)}]`];
        if (m.type === 'http') {
          lines.push(`url = ${tomlStr(m.url)}`);
          if (Object.keys(m.headers || {}).length) lines.push(`http_headers = ${tomlTable(m.headers)}`);
        } else {
          const l = mcpLaunch(m);
          lines.push(`command = ${tomlStr(l.command)}`, `args = [${l.args.map(tomlStr).join(', ')}]`);
          if (Object.keys(m.env || {}).length) lines.push(`env = ${tomlTable(m.env)}`);
        }
        // required: без него codex exec начинает отвечать, не дождавшись запуска сервера, и не видит его инструменты
        lines.push('startup_timeout_sec = 120', 'required = true');
        return lines.join('\n');
      });
      txt = (txt ? txt + '\n\n' : '') + [BEGIN, ...blocks, END].join('\n\n');
    }
    if (txt || fs.existsSync(f)) fs.writeFileSync(f, txt + '\n');
  } else if (agent.provider === 'gemini') {
    const g = path.join(dir, '.gemini'); fs.mkdirSync(g, { recursive: true });
    const f = path.join(g, 'settings.json'), mark = path.join(g, '.agenthub-mcp.json');
    let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    let managed = []; try { managed = JSON.parse(fs.readFileSync(mark, 'utf8')); } catch {}
    s.mcpServers = s.mcpServers || {};
    for (const n of managed) delete s.mcpServers[n];
    for (const m of list) {
      if (m.type === 'http') s.mcpServers[m.name] = { httpUrl: m.url, ...(Object.keys(m.headers || {}).length ? { headers: m.headers } : {}), trust: true, timeout: 120000 };
      else { const l = mcpLaunch(m); s.mcpServers[m.name] = { command: l.command, args: l.args, ...(Object.keys(m.env || {}).length ? { env: m.env } : {}), trust: true, timeout: 120000 }; }
    }
    if (!Object.keys(s.mcpServers).length) delete s.mcpServers;
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
    fs.writeFileSync(mark, JSON.stringify(list.map((m) => m.name)));
  }
}
function syncAllMcp() { for (const a of state.agents) { try { syncMcp(a); } catch (e) { console.error('mcp', a.name, e.message); } } }

// аргументы командной строки, которые нужны программе агента для MCP
function mcpArgs(agent, readOnly) {
  const list = mcpFor(agent);
  if (!list.length || agent.provider !== 'claude') return [];
  const q = (s) => (WIN ? `"${s}"` : `'${s}'`); // запуск идёт через оболочку, в пути есть пробелы
  const out = ['--mcp-config', q(CLAUDE_MCP_FILE(profileOf(agent)))];
  // в обычном режиме Claude спрашивает разрешение на каждый инструмент — заранее разрешаем подключённые серверы
  if (!readOnly && agent.autonomy !== 'full') out.push('--allowedTools', ...list.map((m) => `mcp__${m.name}`));
  return out;
}
function mcpPrompt(agent) {
  const list = mcpFor(agent);
  if (!list.length) return '';
  return 'Тебе подключены MCP-серверы с инструментами — используй их, когда они помогают задаче:\n' + list.map((m) =>
    `- ${m.name}${m.description || m.title ? ` — ${m.description || m.title}` : ''}${m.tools?.length ? ` (инструменты: ${m.tools.slice(0, 25).map((t) => t.name).join(', ')})` : ''}`).join('\n');
}

// --- проверка сервера: подключиться по MCP и получить список инструментов
const MCP_INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-hub', version: '1.0' } } };
function testStdio(m, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const l = mcpLaunch(m);
    let child, buf = '', err = '', done = false;
    const end = (r) => { if (done) return; done = true; clearTimeout(t); try { killTree(child); } catch {} resolve(r); };
    try { child = spawn(l.command, l.args, { env: { ...process.env, ...(m.env || {}) }, windowsHide: true, cwd: PROJECTS_DIR }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    const t = setTimeout(() => end({ ok: false, error: 'Сервер не ответил за ' + Math.round(timeoutMs / 1000) + ' с.' + (err ? '\n' + err.slice(-800) : '') }), timeoutMs);
    const sendMsg = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    child.on('error', (e) => end({ ok: false, error: e.code === 'ENOENT' ? `Команда «${m.command}» не найдена. Установите программу или укажите полный путь.` : e.message }));
    child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    child.on('close', (code) => end({ ok: false, error: `Сервер завершился (код ${code}).` + (err ? '\n' + stripAnsi(err).trim().slice(-800) : '') }));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return end({ ok: false, error: msg.error.message || 'Ошибка инициализации' });
          sendMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });
          sendMsg({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return end({ ok: false, error: msg.error.message || 'Не удалось получить инструменты' });
          return end({ ok: true, tools: (msg.result?.tools || []).map((x) => ({ name: x.name, description: String(x.description || '').split('\n')[0].slice(0, 200) })) });
        }
      }
    });
    sendMsg(MCP_INIT);
  });
}
async function testHttp(m) {
  const hdr = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(m.headers || {}) };
  const parse = async (r) => {
    const t = await r.text();
    if (/text\/event-stream/.test(r.headers.get('content-type') || '')) {
      const datas = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
      for (const d of datas) { try { const j = JSON.parse(d); if (j.id !== undefined) return j; } catch {} }
      return {};
    }
    try { return JSON.parse(t); } catch { return { error: { message: t.slice(0, 300) } }; }
  };
  const ac = AbortSignal.timeout(30000);
  let r = await fetch(m.url, { method: 'POST', headers: hdr, body: JSON.stringify(MCP_INIT), signal: ac });
  if (r.status === 401 || r.status === 403) return { ok: false, error: `Сервер отказал в доступе (${r.status}). Проверьте токен в заголовках.` };
  if (!r.ok) return { ok: false, error: `Сервер ответил ${r.status}` };
  const sid = r.headers.get('mcp-session-id');
  const init = await parse(r);
  if (init.error) return { ok: false, error: init.error.message };
  const h2 = { ...hdr, ...(sid ? { 'Mcp-Session-Id': sid } : {}), ...(init.result?.protocolVersion ? { 'MCP-Protocol-Version': init.result.protocolVersion } : {}) };
  await fetch(m.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(15000) }).catch(() => {});
  r = await fetch(m.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), signal: AbortSignal.timeout(30000) });
  const lst = await parse(r);
  if (lst.error) return { ok: false, error: lst.error.message };
  return { ok: true, tools: (lst.result?.tools || []).map((x) => ({ name: x.name, description: String(x.description || '').split('\n')[0].slice(0, 200) })) };
}
async function testMcp(m) {
  try { return m.type === 'http' ? await testHttp(m) : await testStdio(m); }
  catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'Сервер не ответил вовремя' : e.message }; }
}

// импорт: JSON в формате Claude Desktop / Cursor / .mcp.json ({"mcpServers": {...}}) или один сервер
function importMcpJson(text, all, agents) {
  let j; try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('Это не JSON. Вставьте конфиг вида {"mcpServers": {"имя": {"command": "...", "args": [...]}}}'); }
  const servers = j.mcpServers || j.servers || j.mcp_servers || ((j.command || j.url || j.httpUrl || j.serverUrl) ? { [j.name || 'mcp']: j } : j);
  const added = [];
  for (const [name, c] of Object.entries(servers || {})) {
    if (!c || typeof c !== 'object') continue;
    const url = c.url || c.httpUrl || c.serverUrl;
    added.push(addMcp({ name, type: c.command ? 'stdio' : url ? 'http' : 'stdio', command: c.command, args: c.args, env: c.env, url, headers: c.headers || c.http_headers, all, agents, enabled: c.disabled !== true }));
  }
  if (!added.length) throw new Error('В JSON не нашлось ни одного сервера');
  return added;
}
const DESKTOP_CFG = () => path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');


// ---------------------------------------------------------------- устройства: синхронизация
// Три способа связи, данные одни и те же:
//   folder — облачная папка (Google Диск / OneDrive / Яндекс Диск);
//   server — этот компьютер главный и сам раздаёт хранилище другим устройствам;
//   client — устройство подключено к главному компьютеру.
// Хранилище (vault) — агенты, входы в аккаунты и MCP-серверы, зашифрованные паролем (AES-256-GCM, ключ из scrypt).
// Сервер главного компьютера отдаёт только это зашифрованное хранилище: любой другой запрос — отказ и уведомление.
const os = require('os');
const SYNC_FILE = path.join(DATA, 'sync.json');
const HUB_DIR = path.join(DATA, 'hub-server');
let sync = { mode: null, folder: null, server: null, port: 47800, key: null, deviceId: uid(), deviceName: os.hostname(), hashes: {}, tombstones: {}, joinedAt: 0, lastSync: 0, lastError: null, removed: null, accessLog: [] };
try { sync = { ...sync, ...JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')) }; } catch {}
if (sync.key && !sync.mode) sync.mode = 'folder'; // данные прежней версии
const saveSync = () => { try { fs.writeFileSync(SYNC_FILE, JSON.stringify(sync, null, 2)); } catch (e) { console.error('sync save', e.message); } };
if (!fs.existsSync(SYNC_FILE)) saveSync();
let syncDevices = [];
let syncing = false, syncTimer = null, installerBusy = false;

// ключ синхронизации на диске — под защитой Windows (DPAPI через Electron safeStorage)
let safeStorage = null;
if (EMBEDDED) { try { safeStorage = require('electron').safeStorage; } catch {} }
const protect = (s) => { try { if (safeStorage?.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64'); } catch {} return s; };
const unprotect = (s) => { if (!s) return null; if (!s.startsWith('enc:')) return s; try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return null; } };
let KEY = null;
const getKey = () => { if (!KEY && sync.key) { const k = unprotect(sync.key); if (k) KEY = Buffer.from(k, 'base64'); } return KEY; };
const setKey = (k) => { KEY = k; sync.key = k ? protect(k.toString('base64')) : null; };
// старый ключ в открытом виде — перешифровать, когда защита доступна
function upgradeKeyProtection() { if (sync.key && !sync.key.startsWith('enc:') && safeStorage?.isEncryptionAvailable()) { const k = getKey(); if (k) { setKey(k); saveSync(); } } }

const AGENT_SYNC_FIELDS = ['name', 'provider', 'model', 'role', 'instructions', 'enabled', 'autonomy', 'command', 'color'];
const AUTH_FILES = { claude: ['.credentials.json'], codex: ['auth.json'], gemini: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json'] };
const CLAUDE_ACCOUNT_KEYS = ['oauthAccount', 'userID', 'hasCompletedOnboarding'];

const deriveKey = (pw, salt) => crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function seal(key, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: d.toString('base64') };
}
function unseal(key, e) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8'));
}
function writeAtomic(f, text) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + crypto.randomBytes(4).toString('hex'); fs.writeFileSync(t, text); fs.renameSync(t, f); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const validId = (id) => /^[a-f0-9]{10}$/.test(String(id || ''));

// ---- способы связи (транспорт). Все возвращают одно и то же.
function folderT(folder, devId = sync.deviceId) {
  const devF = (id) => path.join(folder, 'devices', id + '.json'), cmdF = (id) => path.join(folder, 'commands', id + '.json');
  const list = () => {
    const out = [];
    try { for (const n of fs.readdirSync(path.join(folder, 'devices'))) { const d = n.endsWith('.json') && readJson(path.join(folder, 'devices', n)); if (d?.id) out.push({ ...d, pendingLogout: fs.existsSync(cmdF(d.id)) }); } } catch {}
    return out;
  };
  return {
    heartbeat: async (info) => { writeAtomic(devF(devId), JSON.stringify({ ...info, id: devId })); return { devices: list(), command: readJson(cmdF(devId)) }; },
    ackCommand: async () => fs.rmSync(cmdF(devId), { force: true }),
    getVault: async () => readJson(path.join(folder, 'vault.json')),
    putVault: async (raw) => writeAtomic(path.join(folder, 'vault.json'), JSON.stringify(raw)),
    sendCommand: async (id, sealed) => { if (!validId(id)) throw new Error('Нет такого устройства'); writeAtomic(cmdF(id), JSON.stringify(sealed)); },
    forget: async (id) => { if (validId(id)) fs.rmSync(devF(id), { force: true }); },
    leave: async () => { fs.rmSync(devF(devId), { force: true }); fs.rmSync(cmdF(devId), { force: true }); },
    list,
  };
}
// доступы устройств к главному компьютеру: у каждого своё имя и пароль.
// Из пароля получаются два ключа: auth — подпись запросов, wrap — шифрование ключа хранилища и служебных сообщений.
// Сам пароль нигде не хранится; главный компьютер хранит только эти производные ключи (под защитой Windows).
const hubDerive = (pw, salt) => { const kd = deriveKey(pw, salt); return { auth: crypto.createHmac('sha256', kd).update('agent-hub-device-auth').digest(), wrap: crypto.createHmac('sha256', kd).update('agent-hub-key-wrap').digest() }; };
const hubSig = (authKey, method, p, time, nonce, devId, account, body) => crypto.createHmac('sha256', authKey).update([method, p, time, nonce, devId, account, sha(body || '')].join('\n')).digest('hex');
const protectBuf = (b) => protect(b.toString('base64'));
const unprotectBuf = (s) => { const v = unprotect(s); return v ? Buffer.from(v, 'base64') : null; };
const clientCreds = () => ({ account: sync.account, auth: unprotectBuf(sync.authKey), wrap: unprotectBuf(sync.wrapKey) });
function clientT(base, creds = clientCreds()) {
  base = String(base).replace(/\/+$/, '');
  const req = async (method, p, obj) => {
    if (!creds.auth || !creds.wrap) throw new Error('Ключи доступа недоступны — подключите устройство заново');
    const body = obj === undefined ? '' : JSON.stringify(obj);
    const time = String(Date.now()), nonce = crypto.randomBytes(12).toString('hex');
    let r;
    const send = () => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Hub-Device': sync.deviceId, 'X-Hub-Account': encodeURIComponent(creds.account), 'X-Hub-Time': time, 'X-Hub-Nonce': nonce, 'X-Hub-Sig': hubSig(creds.auth, method, p, time, nonce, sync.deviceId, creds.account, body) }, body: body || undefined, signal: AbortSignal.timeout(30000) });
    // ответ «наш» — только JSON от Agent Hub; страница ошибки туннеля значит, что адрес устарел
    const attempt = async () => {
      const res = await send(); const txt = await res.text();
      let js = null, ours = false; try { js = txt ? JSON.parse(txt) : null; ours = true; } catch {}
      if (/text\/html/i.test(res.headers.get('content-type') || '')) ours = false;
      return { res, txt, js, ours };
    };
    let x = null;
    try { x = await attempt(); } catch {}
    const relay = creds.relay || (sync.relay && sync.mode === 'client' ? { t: sync.relay.topic, k: unprotect(sync.relay.key) } : null);
    if ((!x || !x.ours) && relay) {
      // подключение по коду: адрес туннеля сменился — узнать новый и повторить
      const nu = await resolveRelay(relay.t, relay.k);
      if (nu !== base) { base = nu; if (sync.mode === 'client' && !creds.relay) { sync.server = nu; saveSync(); } try { x = await attempt(); } catch { x = null; } }
    }
    if (!x) throw new Error('Главный компьютер недоступен' + (relay ? '' : ' (' + base + ')') + '. Он должен быть включён, Agent Hub открыт.');
    if (!x.ours) throw new Error('Главный компьютер сейчас не в сети: включите его и откройте Agent Hub');
    r = x.res; const t = x.txt; const j = x.js;
    if (r.status === 401) throw new Error('Главный компьютер не принял имя доступа или пароль');
    if (r.status === 403) throw new Error(j?.error || 'Главный компьютер отказал в доступе');
    if (r.status === 429) throw new Error('Главный компьютер временно заблокировал это устройство из-за неверных попыток');
    if (!r.ok) throw new Error(j?.error || 'Ошибка главного компьютера: ' + r.status);
    return j;
  };
  return {
    heartbeat: async (info) => { const j = await req('POST', '/v1/heartbeat', { info: seal(creds.wrap, info) }); return { devices: unseal(creds.wrap, j.devices), command: j.command || null }; },
    fetchKey: async () => { const j = await req('GET', '/v1/key'); return Buffer.from(unseal(creds.wrap, j.wrapped).k, 'base64'); },
    ackCommand: () => req('POST', '/v1/ack'),
    getVault: () => req('GET', '/v1/vault'),
    putVault: (raw) => req('PUT', '/v1/vault', raw),
    sendCommand: async () => { throw new Error('Выходить на других устройствах можно только с главного компьютера'); },
    forget: async () => { throw new Error('Управлять устройствами можно только с главного компьютера'); },
    leave: () => req('POST', '/v1/leave'),
  };
}
const transport = () => sync.mode === 'client' ? clientT(sync.server) : folderT(sync.mode === 'server' ? HUB_DIR : sync.folder);
const syncConnected = () => !!(sync.mode && sync.key);

// ---- входы в аккаунты
function readAuth(a) {
  const files = AUTH_FILES[a.provider]; if (!files) return null;
  const dir = profileOf(a), out = {};
  let mtime = 0;
  for (const rel of files) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { out[rel] = fs.readFileSync(p).toString('base64'); mtime = Math.max(mtime, fs.statSync(p).mtimeMs); }
  }
  if (!Object.keys(out).length) return { files: {}, hash: null, mtime: 0 };
  if (a.provider === 'claude') {
    const j = readJson(path.join(dir, '.claude.json')) || {};
    const acc = Object.fromEntries(CLAUDE_ACCOUNT_KEYS.filter((k) => j[k] !== undefined).map((k) => [k, j[k]]));
    out['@claudeAccount'] = Buffer.from(JSON.stringify(acc)).toString('base64');
  }
  return { files: out, hash: sha(JSON.stringify(out)), mtime };
}
function writeAuth(a, files) {
  const dir = profileOf(a);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, b64] of Object.entries(files || {})) {
    if (rel === '@claudeAccount') {
      const f = path.join(dir, '.claude.json');
      const j = readJson(f) || {};
      Object.assign(j, JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
      fs.writeFileSync(f, JSON.stringify(j, null, 2));
      continue;
    }
    if (!AUTH_FILES[a.provider]?.includes(rel)) continue;
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  }
  if (a.provider === 'gemini') PROVIDERS.gemini.prepareLogin(dir);
}
function wipeAuth(a) {
  const dir = profileOf(a);
  for (const rel of AUTH_FILES[a.provider] || []) fs.rmSync(path.join(dir, rel), { force: true });
  if (a.provider === 'claude') {
    const f = path.join(dir, '.claude.json'); const j = readJson(f);
    if (j) { for (const k of CLAUDE_ACCOUNT_KEYS) delete j[k]; fs.writeFileSync(f, JSON.stringify(j, null, 2)); }
  }
}
function emptyVault() { return { agents: {}, auth: {}, deleted: {}, authRemoved: {}, mcp: null }; }

async function syncNow() {
  if (!syncConnected() || syncing) return;
  syncing = true;
  try {
    let key = getKey();
    if (!key) throw new Error('Ключ синхронизации недоступен — подключите устройство заново');
    if (sync.mode === 'folder' && !fs.existsSync(sync.folder)) throw new Error('Папка синхронизации недоступна: ' + sync.folder);
    const T = transport();
    const now = Date.now();
    // 1) отметка «в сети», список устройств и команда этому устройству
    const hb = await T.heartbeat({ id: sync.deviceId, name: sync.deviceName, platform: `${os.type()} ${os.release()}`, lastSeen: now, agents: state.agents.length, mode: sync.mode });
    syncDevices = (hb.devices || []).map((d) => ({ ...d, self: d.id === sync.deviceId })).sort((a, b) => (b.self - a.self) || (b.lastSeen - a.lastSeen));
    if (hb.command) {
      let cmd = null; try { cmd = unseal(sync.mode === 'client' ? clientCreds().wrap : key, hb.command); } catch {}
      if (cmd?.action === 'logout' && cmd.at > (sync.joinedAt || 0)) return await remoteWipe(cmd, T);
      await T.ackCommand();
    }
    // 2) общее хранилище
    const raw = await T.getVault();
    if (!raw) throw new Error('Хранилище не найдено — подключите устройство заново');
    let v;
    try { v = { ...emptyVault(), ...unseal(key, raw.payload) }; }
    catch (e) {
      // главный компьютер сменил ключ хранилища (после отзыва доступа) — получить новый
      if (sync.mode !== 'client') throw e;
      key = await T.fetchKey(); setKey(key); saveSync();
      v = { ...emptyVault(), ...unseal(key, raw.payload) };
    }
    let changed = false, localChanged = false;

    for (const [id, ts] of Object.entries(sync.tombstones || {})) {
      if (!v.deleted[id] || v.deleted[id] < ts) { v.deleted[id] = ts; delete v.agents[id]; delete v.auth[id]; changed = true; }
    }
    sync.tombstones = {};
    for (const [id, ts] of Object.entries(v.deleted)) {
      const a = agentById(id);
      if (a && (a.updatedAt || 0) <= ts) { wipeAuth(a); state.agents = state.agents.filter((x) => x.id !== id); if (state.leaderId === id) state.leaderId = state.agents[0]?.id || null; localChanged = true; }
    }
    for (const a of state.agents) {
      if (!AUTH_FILES[a.provider] && a.provider !== 'custom') continue;
      const at = a.updatedAt || a.createdAt || 1;
      const r = v.agents[a.id];
      if (!r || at > r.updatedAt) { v.agents[a.id] = { meta: pick(a, AGENT_SYNC_FIELDS), updatedAt: at }; changed = true; }
      else if (r.updatedAt > at) { Object.assign(a, r.meta); a.updatedAt = r.updatedAt; localChanged = true; }
    }
    for (const [id, r] of Object.entries(v.agents)) {
      if (agentById(id) || v.deleted[id]) continue;
      state.agents.push({ id, ...r.meta, updatedAt: r.updatedAt });
      if (!state.leaderId) state.leaderId = id;
      localChanged = true;
    }
    const pulled = [];
    for (const a of state.agents) {
      const cur = readAuth(a); if (!cur) continue;
      const rem = v.auth[a.id], last = sync.hashes[a.id] || null;
      if (cur.hash && cur.hash !== last) {
        if (!rem || rem.hash === last || cur.mtime >= rem.updatedAt) {
          v.auth[a.id] = { files: cur.files, hash: cur.hash, updatedAt: now, by: sync.deviceId };
          delete v.authRemoved[a.id]; sync.hashes[a.id] = cur.hash; changed = true;
        } else { wipeAuth(a); writeAuth(a, rem.files); sync.hashes[a.id] = rem.hash; pulled.push(a); }
      } else if (!cur.hash && last && rem && rem.hash === last) {
        delete v.auth[a.id]; v.authRemoved[a.id] = now; sync.hashes[a.id] = null; changed = true;
      } else if (rem && rem.hash !== cur.hash) {
        wipeAuth(a); writeAuth(a, rem.files); sync.hashes[a.id] = rem.hash; pulled.push(a);
      } else if (cur.hash && !rem && v.authRemoved[a.id] && cur.hash === last) {
        wipeAuth(a); sync.hashes[a.id] = null; pulled.push(a);
      }
    }
    const mcpAt = state.mcpUpdatedAt || 0;
    if (!v.mcp || mcpAt > v.mcp.updatedAt) { v.mcp = { list: state.mcp, updatedAt: mcpAt || now }; if (!state.mcpUpdatedAt) state.mcpUpdatedAt = v.mcp.updatedAt; changed = true; }
    else if (v.mcp.updatedAt > mcpAt) { state.mcp = v.mcp.list || []; state.mcpUpdatedAt = v.mcp.updatedAt; localChanged = true; syncAllMcp(); }

    if (changed) await T.putVault({ ...raw, updatedAt: now, by: sync.deviceId, payload: seal(key, v) });
    if (localChanged) { save(); try { syncAllSkills(); } catch {} }
    for (const a of pulled) refreshAuth(a);
    if (localChanged && !pulled.length) for (const a of state.agents) if (!authStatus[a.id]) refreshAuth(a);
    sync.lastSync = now; sync.lastError = null;
  } catch (e) {
    sync.lastError = /Unsupported state|unable to authenticate/i.test(e.message) ? 'Пароль не подходит к хранилищу' : e.message;
  } finally { syncing = false; saveSync(); pushState(); }
}
const syncSoon = () => { if (!syncConnected()) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1500); };
setInterval(() => { syncNow(); }, 60000).unref();

async function remoteWipe(cmd, T) {
  for (const b of busy.values()) { try { killTree(b.child); } catch {} }
  for (const a of state.agents) { try { wipeAuth(a); } catch {} }
  try { await T.ackCommand(); } catch {}
  try { await T.leave(); } catch {}
  stopHubServer();
  sync.removed = { at: Date.now(), by: cmd.by || 'другое устройство' };
  Object.assign(sync, { mode: null, folder: null, server: null, hashes: {}, account: null, authKey: null, wrapKey: null }); setKey(null); syncDevices = [];
  saveSync();
  for (const a of state.agents) refreshAuth(a);
}

// ---- подключение
async function connectSync({ mode, folder, server, password, deviceName, port, account }) {
  mode = ['folder', 'server', 'client'].includes(mode) ? mode : 'folder';
  const name = String(deviceName || sync.deviceName).trim() || os.hostname();
  if (mode !== 'server' && (!password || String(password).length < 8)) throw new Error('Пароль — не короче 8 символов');
  let raw = null, key = null, extra = { account: null, authKey: null, wrapKey: null };
  if (mode === 'folder') {
    folder = String(folder || '').trim(); if (!folder) throw new Error('Выберите папку');
    folder = path.resolve(folder);
    if (!fs.existsSync(path.dirname(folder))) throw new Error('Такой папки нет: ' + path.dirname(folder));
    fs.mkdirSync(folder, { recursive: true });
    const T = folderT(folder);
    raw = await T.getVault();
    if (raw) {
      key = deriveKey(password, raw.salt);
      try { unseal(key, raw.payload); } catch { throw new Error('Неверный пароль. Он должен совпадать с паролем на первом устройстве.'); }
    } else {
      const salt = crypto.randomBytes(16).toString('base64');
      key = deriveKey(password, salt);
      await T.putVault({ app: 'agent-hub', v: 1, salt, createdAt: Date.now(), by: sync.deviceId, payload: seal(key, emptyVault()) });
    }
  } else if (mode === 'server') {
    // ключ хранилища главного компьютера — случайный; устройствам он выдаётся зашифрованным их личным паролем
    port = Number(port) || sync.port || 47800;
    fs.mkdirSync(HUB_DIR, { recursive: true });
    const T = folderT(HUB_DIR);
    raw = await T.getVault();
    key = raw && sync.serverKey ? unprotectBuf(sync.serverKey) : null;
    if (key) { try { unseal(key, raw.payload); } catch { key = null; } }
    if (!key) {
      key = crypto.randomBytes(32); raw = null;
      await T.putVault({ app: 'agent-hub', v: 2, salt: crypto.randomBytes(16).toString('base64'), createdAt: Date.now(), by: sync.deviceId, payload: seal(key, emptyVault()) });
    }
    sync.serverKey = protectBuf(key);
    if (!sync.serverSecret) sync.serverSecret = protectBuf(crypto.randomBytes(32));
    sync.accounts = sync.accounts || [];
  } else {
    // адрес или код подключения (AH1-…): по коду адрес туннеля находится сам
    const code = parseCode(server);
    if (code) { account = account || code.a; extra.relay = { topic: code.t, key: protect(code.k) }; }
    else server = normServerUrl(server);
    account = String(account || '').trim();
    if (!account) throw new Error('Введите имя доступа — его создают на главном компьютере');
    let hello = null;
    // по коду: адрес туннеля мог только что смениться — несколько попыток со свежим адресом
    for (let i = 0; i < (code ? 4 : 1) && !hello; i++) {
      if (i) await new Promise((r) => setTimeout(r, 4000));
      if (code) server = await resolveRelay(code.t, code.k);
      try { const j = await (await fetch(server + '/v1/hello?account=' + encodeURIComponent(account), { signal: AbortSignal.timeout(15000) })).json(); if (j?.app === 'agent-hub') hello = j; } catch {}
    }
    if (!hello) throw new Error(code ? 'Главный компьютер сейчас не в сети: включите его и откройте Agent Hub' : 'Не удалось связаться с главным компьютером ' + server + '. Проверьте адрес, что он включён и в нём открыт Agent Hub.');
    if (hello?.app !== 'agent-hub' || !hello.salt) throw new Error('По этому адресу не Agent Hub в режиме главного компьютера');
    if ((hello.v || 1) < 2) throw new Error('На главном компьютере старая версия Agent Hub — обновите её');
    const d = hubDerive(password, hello.salt);
    const creds = { account, auth: d.auth, wrap: d.wrap };
    const T = clientT(server, creds);
    try { key = await T.fetchKey(); }
    catch (e) { throw new Error(/не принял/.test(e.message) ? 'Неверное имя доступа или пароль' : e.message); }
    raw = await T.getVault();
    extra = { account, authKey: protectBuf(d.auth), wrapKey: protectBuf(d.wrap), relay: extra.relay || null };
  }
  if (sync.mode === 'server' && mode !== 'server') { stopHubServer(); stopTunnel(); sync.internet = false; }
  Object.assign(sync, { mode, folder: mode === 'folder' ? folder : null, server: mode === 'client' ? server : null, port: mode === 'server' ? port : sync.port,
    deviceName: name, hashes: {}, tombstones: {}, joinedAt: Date.now(), removed: null, lastError: null, ...extra });
  setKey(key);
  if (raw) for (const a of state.agents) { const cur = readAuth(a); if (cur?.hash) sync.hashes[a.id] = '(local)'; }
  saveSync();
  if (mode === 'server') await startHubServer();
  await syncNow();
  if (sync.lastError) throw new Error(sync.lastError);
  return { created: !raw };
}

// ---- доступы устройств (только на главном компьютере)
const hubAccount = (name) => (sync.accounts || []).find((a) => a.name.toLowerCase() === String(name || '').trim().toLowerCase());
function addAccount({ name, password }) {
  if (sync.mode !== 'server') throw new Error('Сначала сделайте этот компьютер главным');
  name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) throw new Error('Укажите имя доступа, например «Ноутбук»');
  if (!password || String(password).length < 8) throw new Error('Пароль — не короче 8 символов');
  if (hubAccount(name)) throw new Error('Доступ с таким именем уже есть');
  const salt = crypto.randomBytes(16).toString('base64');
  const d = hubDerive(password, salt);
  const a = { id: uid(), name, salt, auth: protectBuf(d.auth), wrap: protectBuf(d.wrap), createdAt: Date.now(), lastUsed: 0, deviceId: null, revoked: null };
  sync.accounts.push(a); saveSync(); pushState();
  return { id: a.id, name: a.name };
}
// сменить ключ хранилища: отозванное устройство со старым ключом больше ничего не расшифрует
async function rotateServerKey() {
  const T = folderT(HUB_DIR); const raw = await T.getVault(); const old = getKey();
  if (!raw || !old) return;
  const v = unseal(old, raw.payload);
  const nk = crypto.randomBytes(32);
  await T.putVault({ ...raw, updatedAt: Date.now(), payload: seal(nk, v) });
  setKey(nk); sync.serverKey = protectBuf(nk); saveSync();
}
async function revokeAccount(id) {
  if (sync.mode !== 'server') throw new Error('Доступами управляет главный компьютер');
  const a = (sync.accounts || []).find((x) => x.id === id); if (!a) throw new Error('Нет такого доступа');
  if (a.deviceId) {
    // команда «выйти» зашифрована личным ключом устройства — она дойдёт, даже когда ключ хранилища сменится
    await folderT(HUB_DIR).sendCommand(a.deviceId, seal(unprotectBuf(a.wrap), { action: 'logout', at: Date.now(), by: sync.deviceName }));
    a.revoked = Date.now();
  } else sync.accounts = sync.accounts.filter((x) => x !== a); // ещё не использовался — просто удалить
  await rotateServerKey();
  saveSync(); await syncNow(); pushState();
}
async function forgetAccount(id) {
  const a = (sync.accounts || []).find((x) => x.id === id); if (!a) throw new Error('Нет такого доступа');
  if (!a.revoked) throw new Error('Сначала отзовите доступ');
  sync.accounts = sync.accounts.filter((x) => x !== a);
  if (a.deviceId) await folderT(HUB_DIR, a.deviceId).leave();
  saveSync(); await syncNow(); pushState();
}
function normServerUrl(s) {
  s = String(s || '').trim(); if (!s) throw new Error('Введите адрес главного компьютера');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s); if (!u.port && u.protocol === 'http:') u.port = '47800';
  return `${u.protocol}//${u.host}`;
}
async function disconnectSync() {
  stopTunnel(); sync.internet = false;
  try { if (syncConnected()) await transport().leave(); } catch {}
  stopHubServer();
  Object.assign(sync, { mode: null, folder: null, server: null, hashes: {}, tombstones: {}, lastError: null }); setKey(null);
  syncDevices = []; saveSync(); pushState();
}
async function remoteLogout(deviceId) {
  if (!syncConnected()) throw new Error('Синхронизация не подключена');
  if (deviceId === sync.deviceId) throw new Error('Это устройство — для него нажмите «Отключить»');
  if (sync.mode === 'server') {
    const acc = (sync.accounts || []).find((a) => a.deviceId === deviceId);
    if (acc) return revokeAccount(acc.id);
  }
  await transport().sendCommand(deviceId, seal(getKey(), { action: 'logout', at: Date.now(), by: sync.deviceName }));
  await syncNow();
}
async function forgetDevice(deviceId) { if (!syncConnected()) throw new Error('Синхронизация не подключена'); await transport().forget(deviceId); await syncNow(); }

// ---- сервер главного компьютера: только зашифрованное хранилище
let hubServer = null;
const hubNonces = new Map();      // nonce -> время
const hubFails = new Map();       // ip -> { n, until }
const hubToastAt = new Map();
const hubKnown = new Set();
function hubLog(entry) {
  sync.accessLog = [{ at: Date.now(), ...entry }, ...(sync.accessLog || [])].slice(0, 60);
  saveSync();
  const k = entry.ip + entry.kind;
  if (Date.now() - (hubToastAt.get(k) || 0) > 60000) {
    hubToastAt.set(k, Date.now());
    broadcast('toast', { text: `⚠ Главный компьютер отклонил запрос с ${entry.ip}: ${entry.why}`, kind: 'err' });
  }
  pushState();
}
function hubSend(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); }
const HUB_ROUTES = [
  ['POST', /^\/v1\/heartbeat$/], ['POST', /^\/v1\/ack$/], ['POST', /^\/v1\/leave$/],
  ['GET', /^\/v1\/key$/], ['GET', /^\/v1\/vault$/], ['PUT', /^\/v1\/vault$/],
  // команды устройствам (выход, удаление из списка) отдаёт только сам главный компьютер — снаружи их не принимаем
];
const REVOKED_OK = new Set(['/v1/heartbeat', '/v1/ack', '/v1/leave']); // отозванному доступу — только чтобы получить команду «выйти»
// для несуществующего имени отдаём правдоподобную соль, чтобы по ответу нельзя было подобрать имена доступов
const fakeSalt = (name) => crypto.createHmac('sha256', unprotectBuf(sync.serverSecret) || Buffer.alloc(32)).update('salt:' + String(name).toLowerCase()).digest().subarray(0, 16).toString('base64');
async function hubHandle(req, res) {
  let ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // запрос пришёл через туннель Cloudflare — настоящий адрес в заголовке (доверяем ему только от локального туннеля)
  // (Cloudflare — cf-connecting-ip, localhost.run — x-forwarded-for)
  const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if ((ip === '127.0.0.1' || ip === '::1') && fwd) ip = String(fwd).slice(0, 45) + ' (интернет)';
  const url = new URL(String(req.url || '/'), 'http://hub');
  const p = url.pathname;
  const f = hubFails.get(ip);
  if (f && f.until > Date.now()) return hubSend(res, 429, { error: 'Слишком много неверных попыток' });
  let body = '';
  try {
    body = await new Promise((resolve, reject) => {
      let b = ''; req.on('data', (d) => { b += d; if (b.length > 25e6) { reject(new Error('big')); req.destroy(); } });
      req.on('end', () => resolve(b)); req.on('error', reject);
    });
  } catch { return; }
  const key = getKey();
  if (sync.mode !== 'server' || !key) return hubSend(res, 503, { error: 'Сервер выключен' });
  if (req.method === 'GET' && p === '/v1/hello') {
    const nm = String(url.searchParams.get('account') || '').slice(0, 60);
    const acc = hubAccount(nm);
    return hubSend(res, 200, { app: 'agent-hub', v: 2, salt: acc ? acc.salt : fakeSalt(nm) });
  }
  const route = HUB_ROUTES.find(([m, re]) => m === req.method && re.test(p));
  if (!route) { hubLog({ ip, kind: 'denied', why: `запрос «${req.method} ${p.slice(0, 80)}» — доступ запрещён` }); return hubSend(res, 403, { error: 'Доступ запрещён' }); }
  // подпись личным ключом доступа
  const dev = String(req.headers['x-hub-device'] || ''), time = String(req.headers['x-hub-time'] || ''), nonce = String(req.headers['x-hub-nonce'] || ''), sig = String(req.headers['x-hub-sig'] || '');
  let accName = ''; try { accName = decodeURIComponent(String(req.headers['x-hub-account'] || '')); } catch {}
  const acc = hubAccount(accName);
  const authKey = acc && unprotectBuf(acc.auth);
  const fresh = Math.abs(Date.now() - Number(time)) < 120000;
  const expect = authKey ? hubSig(authKey, req.method, p, time, nonce, dev, acc.name, body) : '';
  const sigOk = !!authKey && sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  if (!validId(dev) || !fresh || !nonce || hubNonces.has(nonce) || !sigOk) {
    const n = (f?.n || 0) + 1;
    hubFails.set(ip, { n, until: n >= 8 ? Date.now() + 30 * 60000 : 0 });
    const who = accName ? `«${accName.slice(0, 40)}»` : 'без имени';
    hubLog({ ip, kind: 'auth', why: !sigOk ? `неверное имя доступа или пароль (${who})` + (n >= 8 ? ' — адрес заблокирован на 30 минут' : '') : !fresh ? 'просроченный запрос' : 'повтор перехваченного запроса' });
    return hubSend(res, 401, { error: 'Нет доступа' });
  }
  hubFails.delete(ip);
  hubNonces.set(nonce, Date.now());
  if (hubNonces.size > 5000) for (const [k, t] of hubNonces) if (Date.now() - t > 300000) hubNonces.delete(k);
  // один доступ — одно устройство
  if (acc.deviceId && acc.deviceId !== dev) {
    hubLog({ ip, kind: 'denied', why: `доступ «${acc.name}» использован с другого устройства — отказ` });
    return hubSend(res, 403, { error: 'Этот доступ уже привязан к другому устройству. Создайте на главном компьютере отдельный доступ.' });
  }
  if (acc.revoked && !REVOKED_OK.has(p)) {
    hubLog({ ip, kind: 'denied', why: `отозванный доступ «${acc.name}» запросил ${p} — отказ` });
    return hubSend(res, 403, { error: 'Доступ этого устройства отозван' });
  }
  if (!acc.deviceId) acc.deviceId = dev;
  if (Date.now() - (acc.lastUsed || 0) > 30000) { acc.lastUsed = Date.now(); saveSync(); }
  let obj = null; try { obj = body ? JSON.parse(body) : null; } catch { return hubSend(res, 400, { error: 'Неверный запрос' }); }
  const wrap = unprotectBuf(acc.wrap);
  const T = folderT(HUB_DIR, dev);
  try {
    if (p === '/v1/heartbeat') {
      const info = unseal(wrap, obj.info);
      const r = await T.heartbeat({ id: dev, name: String(info.name || 'Устройство').slice(0, 60), platform: String(info.platform || '').slice(0, 80), lastSeen: Date.now(), agents: Number(info.agents) || 0, mode: 'client', ip, account: acc.name });
      if (!hubKnown.has(dev)) {
        hubKnown.add(dev);
        if (!syncDevices.some((d) => d.id === dev)) broadcast('toast', { text: `Подключилось устройство «${info.name}» (доступ «${acc.name}», ${ip})` });
      }
      return hubSend(res, 200, { devices: seal(wrap, r.devices.map(({ ip: _ip, ...d }) => d)), command: r.command });
    }
    if (p === '/v1/ack') {
      await T.ackCommand();
      if (acc.revoked) { sync.accounts = sync.accounts.filter((x) => x !== acc); await T.leave(); saveSync(); broadcast('toast', { text: `Устройство с доступом «${acc.name}» вышло из аккаунтов` }); setTimeout(syncNow, 300); }
      return hubSend(res, 200, { ok: true });
    }
    if (p === '/v1/leave') { await T.leave(); return hubSend(res, 200, { ok: true }); }
    if (p === '/v1/key') return hubSend(res, 200, { wrapped: seal(wrap, { k: key.toString('base64') }) });
    if (p === '/v1/vault' && req.method === 'GET') return hubSend(res, 200, readJson(path.join(HUB_DIR, 'vault.json')));
    if (p === '/v1/vault' && req.method === 'PUT') {
      const cur = readJson(path.join(HUB_DIR, 'vault.json'));
      if (!cur || obj.salt !== cur.salt) throw new Error('salt');
      unseal(key, obj.payload); // принимаем только хранилище, зашифрованное текущим ключом
      await T.putVault(obj); setTimeout(syncNow, 300); return hubSend(res, 200, { ok: true });
    }
  } catch (e) { return hubSend(res, 400, { error: 'Неверный запрос' }); }
  hubSend(res, 404, { error: 'Нет' });
}
function startHubServer() {
  return new Promise((resolve, reject) => {
    if (hubServer) return resolve();
    const s = http.createServer((req, res) => { hubHandle(req, res).catch(() => { try { hubSend(res, 500, { error: 'Ошибка' }); } catch {} }); });
    s.headersTimeout = 15000; s.requestTimeout = 60000;
    s.once('error', (e) => { hubServer = null; sync.lastError = e.code === 'EADDRINUSE' ? `Порт ${sync.port} занят другой программой` : e.message; pushState(); reject(new Error(sync.lastError)); });
    s.listen(sync.port, '0.0.0.0', () => { hubServer = s; resolve(); });
  });
}
function stopHubServer() { if (hubServer) { try { hubServer.close(); } catch {} hubServer = null; } }
function hubAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|docker|virtualbox|vmware|hyper-v|loopback/i.test(name)) continue; // виртуальные адаптеры — не для других устройств
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const kind = /tailscale/i.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) ? 'tailscale'
        : /vpn|radmin|zerotier|hamachi|tun|tap|wireguard|wg\d/i.test(name) ? 'other'
        : /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) ? 'lan' : 'other';
      out.push({ address: `${a.address}:${sync.port}`, kind, iface: name });
    }
  }
  const order = { tailscale: 0, lan: 1, other: 2 };
  return out.sort((x, y) => order[x.kind] - order[y.kind]);
}
// ---- доступ через интернет без настройки сети
// Главный компьютер открывает туннель Cloudflare (trycloudflare.com: без аккаунта, без портов на роутере).
// Адрес туннеля меняется при каждом запуске, поэтому главный публикует его зашифрованным в ntfy.sh;
// устройство по «коду подключения» находит актуальный адрес само. Обоим сервисам видны только шифротексты.
const CF_BIN = path.join(DATA, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const CF_DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const RELAY = 'https://ntfy.sh';
const tunnel = { status: 'off', url: null, error: null, child: null, progress: 0 };
async function ensureCloudflared() {
  if (fs.existsSync(CF_BIN) && fs.statSync(CF_BIN).size > 5e6) return;
  if (process.platform !== 'win32') throw new Error('Установите cloudflared вручную');
  tunnel.status = 'downloading'; tunnel.progress = 0; pushState();
  const r = await fetch(CF_DOWNLOAD, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
  if (!r.ok || !r.body) throw new Error('GitHub ответил ' + r.status);
  const total = Number(r.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(CF_BIN), { recursive: true });
  const tmp = CF_BIN + '.download';
  const out = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  for await (const chunk of r.body) {
    out.write(chunk); got += chunk.length;
    if (total && Date.now() - last > 700) { last = Date.now(); tunnel.progress = Math.round(got / total * 100); pushState(); }
  }
  await new Promise((res) => out.end(res));
  const head = Buffer.alloc(2); const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  if (got < 5e6 || head.toString() !== 'MZ') { fs.rmSync(tmp, { force: true }); throw new Error('скачан не тот файл'); }
  fs.renameSync(tmp, CF_BIN);
}
// Провайдеры туннеля по очереди: Cloudflare, затем localhost.run через встроенный в Windows SSH
// (у части провайдеров Cloudflare-туннели режут DPI, а SSH проходит).
const SSH_BIN = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
const TUNNEL_URL_RE = /^https:\/\/[a-z0-9-]+\.(trycloudflare\.com|lhr\.life)$/;
const TUNNEL_PROVIDERS = [
  { id: 'cloudflare', label: 'Cloudflare', prepare: ensureCloudflared,
    args: () => [CF_BIN, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${sync.port}`]],
    url: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    blocked: (log) => /hard_fail=true/.test(log) || (log.match(/TLS handshake with edge error/g) || []).length >= 2 },
  { id: 'lhr', label: 'localhost.run', prepare: async () => { if (!fs.existsSync(SSH_BIN)) throw new Error('нет встроенного SSH'); },
    args: () => [SSH_BIN, ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(DATA, 'known_hosts')}`,
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${sync.port}`, 'nokey@localhost.run']],
    url: /https:\/\/[a-z0-9-]+\.lhr\.life/,
    // только настоящие ошибки ssh (в приветствии localhost.run есть фраза «permission denied error» — это не ошибка)
    blocked: (log) => /^[\w@.-]*:? ?Permission denied \(|^ssh: connect to host .* (Connection refused|Connection timed out|Network is unreachable)|^ssh: Could not resolve hostname|^Connection (reset|closed) by /m.test(log) },
];
let tunnelRestarts = 0, providerIdx = 0;
async function startTunnel() {
  if (sync.mode !== 'server' || !sync.internet || tunnel.child) return;
  const prov = TUNNEL_PROVIDERS[providerIdx % TUNNEL_PROVIDERS.length];
  try { await prov.prepare(); }
  catch (e) { tunnel.error = `${prov.label}: ${e.message}`; pushState(); return nextProvider(); }
  if (sync.mode !== 'server' || !sync.internet || tunnel.child) return;
  tunnel.status = 'starting'; tunnel.provider = prov.label; pushState();
  const [bin, args] = prov.args();
  const c = spawn(bin, args, { ...HIDE, cwd: DATA });
  tunnel.child = c;
  let log = '', switched = false;
  const logFile = path.join(DATA, 'tunnel.log');
  try { fs.writeFileSync(logFile, `== ${prov.label} ==\n`); } catch {}
  const onData = (d) => {
    const s = String(d); log = (log + s).slice(-6000);
    try { fs.appendFileSync(logFile, s); } catch {}
    const m = s.match(prov.url);
    if (m && m[0] !== tunnel.url) { tunnel.url = m[0]; tunnel.status = 'starting'; pushState(); verifyTunnel(c, m[0]); }
    // провайдер заблокирован в этой сети — сразу пробуем следующий
    if (!switched && tunnel.status !== 'on' && prov.blocked(log)) { switched = true; tunnel.error = `${prov.label} заблокирован в этой сети — пробую другой способ`; pushState(); c.switchProvider = true; try { killTree(c); } catch {} }
  };
  c.stdout.on('data', onData); c.stderr.on('data', onData);
  c.on('error', (e) => { tunnel.error = e.message; });
  c.on('close', () => {
    if (tunnel.child !== c) return;
    const wasOn = tunnel.status === 'on';
    tunnel.child = null; tunnel.url = null;
    if (!(sync.internet && sync.mode === 'server')) { tunnel.status = 'off'; pushState(); return; }
    tunnel.status = 'starting';
    if (c.switchProvider || !wasOn) { tunnelRestarts++; return nextProvider(); }
    // работал и оборвался — переподключиться тем же способом (адрес сменится и опубликуется заново)
    pushState(); setTimeout(startTunnel, 3000);
  });
}
function nextProvider() {
  providerIdx++;
  if (tunnelRestarts >= TUNNEL_PROVIDERS.length * 2) { tunnel.status = 'error'; tunnel.error = 'Ни один способ туннеля не работает в этой сети. Используйте Tailscale или подключайтесь в одной сети.'; }
  pushState();
  setTimeout(startTunnel, tunnelRestarts >= TUNNEL_PROVIDERS.length * 2 ? 60000 : 2000);
}
// «Работает» — только когда главный реально отвечает сам себе через интернет; тогда и публикуем адрес
async function verifyTunnel(c, url) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 2000 : 4000));
    if (tunnel.child !== c || tunnel.url !== url) return;
    try {
      const r = await fetch(url + '/v1/hello?account=self-check', { signal: AbortSignal.timeout(10000) });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (j?.app === 'agent-hub') { tunnel.status = 'on'; tunnel.error = null; tunnelRestarts = 0; sync.tunnelProvider = providerIdx % TUNNEL_PROVIDERS.length; saveSync(); publishRelay(); pushState(); return; }
    } catch {}
  }
  if (tunnel.child !== c) return;
  tunnel.error = `${tunnel.provider} не отвечает — пробую другой способ`; pushState();
  c.switchProvider = true;
  try { killTree(c); } catch {}
}
function stopTunnel() { const c = tunnel.child; tunnel.child = null; tunnel.url = null; tunnel.status = 'off'; tunnel.error = null; if (c) { try { killTree(c); } catch {} } }
const relayKey = () => unprotectBuf(sync.relay?.key);
let relayRetry = null;
const tunnelLog = (s) => { try { fs.appendFileSync(path.join(DATA, 'tunnel.log'), `\n[agent-hub ${new Date().toLocaleTimeString('ru-RU')}] ${s}\n`); } catch {} };
async function publishRelay() {
  clearTimeout(relayRetry);
  if (!tunnel.url || tunnel.status !== 'on') return;
  const url = tunnel.url;
  try {
    // ключ канала мог не расшифроваться (например, после переустановки) — тогда создаём канал заново; старые коды перестанут работать
    let key = sync.relay ? relayKey() : null;
    if (!sync.relay || !key) {
      tunnelLog('ключ канала адреса недоступен — создаю новый канал');
      key = crypto.randomBytes(32);
      sync.relay = { topic: 'agenthub-' + crypto.randomBytes(16).toString('hex'), key: protectBuf(key) };
      tunnel.relayReset = true;
    }
    const body = JSON.stringify(seal(key, { url, at: Date.now() }));
    const r = await fetch(`${RELAY}/${sync.relay.topic}`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('ntfy ответил ' + r.status);
    sync.relay.publishedAt = Date.now(); tunnel.publishedAt = sync.relay.publishedAt; saveSync();
    tunnelLog('адрес опубликован: ' + url);
    if (tunnel.error) { tunnel.error = null; pushState(); } else pushState();
  } catch (e) {
    tunnelLog('адрес не опубликован: ' + e.message);
    tunnel.error = 'Адрес не опубликован (' + e.message + ') — повторю через минуту'; pushState();
    relayRetry = setTimeout(publishRelay, 60000);
  }
}
setInterval(() => { if (tunnel.url && tunnel.status === 'on') publishRelay(); }, 3 * 3600e3).unref(); // ntfy хранит сообщения 12 часов
async function resolveRelay(topic, keyB64) {
  let t;
  try { t = await (await fetch(`${RELAY}/${encodeURIComponent(topic)}/json?poll=1&since=24h`, { signal: AbortSignal.timeout(15000) })).text(); }
  catch { throw new Error('Нет связи с ntfy.sh — проверьте интернет'); }
  let best = null;
  for (const line of t.split('\n')) {
    try { const ev = JSON.parse(line); if (ev.event !== 'message') continue; const m = unseal(Buffer.from(keyB64, 'base64'), JSON.parse(ev.message)); if (TUNNEL_URL_RE.test(m.url) && (!best || m.at > best.at)) best = m; } catch {}
  }
  if (!best) throw new Error('Главный компьютер сейчас не в сети: включите его и откройте Agent Hub');
  return best.url;
}
function setInternet(on) {
  if (sync.mode !== 'server') throw new Error('Сначала сделайте этот компьютер главным');
  sync.internet = !!on;
  if (on && !sync.relay) sync.relay = { topic: 'agenthub-' + crypto.randomBytes(16).toString('hex'), key: protectBuf(crypto.randomBytes(32)) };
  saveSync();
  if (on) { tunnelRestarts = 0; providerIdx = sync.tunnelProvider || 0; startTunnel(); } else stopTunnel();
  pushState();
}
// код подключения: где искать адрес главного + имя доступа. Пароль в код не входит.
function accountCode(id) {
  const a = (sync.accounts || []).find((x) => x.id === id); if (!a) throw new Error('Нет такого доступа');
  if (!sync.internet || !sync.relay) throw new Error('Сначала включите «Доступ через интернет»');
  return { code: 'AH1-' + Buffer.from(JSON.stringify({ t: sync.relay.topic, k: relayKey().toString('base64'), a: a.name })).toString('base64url'), name: a.name };
}
function parseCode(s) {
  const m = String(s || '').trim().match(/^AH1-([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try { const j = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); if (j.t && j.k && j.a) return j; } catch {}
  throw new Error('Код подключения повреждён — скопируйте его заново');
}

function cloudCandidates() {
  const out = [], seen = new Set();
  const add = (label, p) => { if (!p) return; try { if (fs.existsSync(p) && !seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); out.push({ label, path: path.join(p, 'Agent Hub') }); } } catch {} };
  add('Google Диск', path.join(os.homedir(), 'Google Drive', 'Мой диск'));
  add('Google Диск', path.join(os.homedir(), 'Google Drive', 'My Drive'));
  if (WIN) for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') { add('Google Диск', `${L}:\\Мой диск`); add('Google Диск', `${L}:\\My Drive`); }
  add('OneDrive', process.env.OneDriveConsumer); add('OneDrive', process.env.OneDrive);
  add('Яндекс Диск', path.join(os.homedir(), 'YandexDisk'));
  add('Dropbox', path.join(os.homedir(), 'Dropbox'));
  return out;
}

// установщик приложения: в облачную папку или на рабочий стол
function makeInstaller() {
  if (!EMBEDDED) throw new Error('Установщик можно сделать только из установленного приложения');
  if (installerBusy) throw new Error('Уже собираю установщик');
  const appDir = path.dirname(process.execPath);
  const destDir = sync.mode === 'folder' && sync.folder ? sync.folder : path.join(os.homedir(), 'Desktop');
  const out = path.join(destDir, 'Agent Hub — установка.zip');
  installerBusy = true; pushState();
  const tmp = path.join(os.tmpdir(), 'agenthub-installer-' + Date.now() + '.zip');
  // zip через .NET ZipFile: такой архив распаковывает «Проводник» (zip от tar.exe он не открывает)
  const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:AH_SRC, $env:AH_OUT, [System.IO.Compression.CompressionLevel]::Optimal, $false)'],
  { ...HIDE, env: { ...process.env, AH_SRC: appDir, AH_OUT: tmp } });
  c.on('close', (code) => {
    try {
      if (code !== 0) throw new Error('архивация завершилась с кодом ' + code);
      fs.copyFileSync(tmp, out);
      broadcast('toast', { text: `Установщик готов: ${out}` });
    } catch (e) { broadcast('toast', { text: 'Не удалось сделать установщик: ' + e.message, kind: 'err' }); }
    finally { fs.rmSync(tmp, { force: true }); installerBusy = false; pushState(); }
  });
  c.on('error', (e) => { installerBusy = false; pushState(); broadcast('toast', { text: 'Не удалось сделать установщик: ' + e.message, kind: 'err' }); });
}
const syncPublic = () => ({
  connected: syncConnected(), mode: sync.mode, folder: sync.folder, server: sync.server, port: sync.port,
  serverRunning: !!hubServer, internet: !!sync.internet, tunnel: { status: tunnel.status, url: tunnel.url, error: tunnel.error, progress: tunnel.progress, provider: tunnel.provider, publishedAt: tunnel.publishedAt || null, relayReset: !!tunnel.relayReset }, viaCode: sync.mode === 'client' && !!sync.relay, addresses: sync.mode === 'server' ? hubAddresses() : [],
  deviceId: sync.deviceId, deviceName: sync.deviceName, lastSync: sync.lastSync, lastError: sync.lastError, removed: sync.removed,
  accounts: sync.mode === 'server' ? (sync.accounts || []).map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt, lastUsed: a.lastUsed, deviceId: a.deviceId, revoked: a.revoked })) : [],
  account: sync.mode === 'client' ? sync.account : null,
  devices: syncConnected() ? syncDevices : [], accessLog: sync.mode === 'server' ? (sync.accessLog || []).slice(0, 30) : [],
  installerBusy, canInstaller: EMBEDDED, keyProtected: !!(sync.key && sync.key.startsWith('enc:')),
});

// ---------------------------------------------------------------- HTTP API
function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 80e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const AGENT_FIELDS = ['name', 'provider', 'model', 'role', 'instructions', 'enabled', 'autonomy', 'command', 'profileDir', 'color'];
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }

const routes = {
  'GET /api/state': async () => publicState(),

  'POST /api/agents': async (b) => {
    if (!PROVIDERS[b.provider]) throw new Error('Неизвестный тип агента');
    const name = String(b.name || '').trim().replace(/\s+/g, '_');
    if (!name) throw new Error('Нужно имя');
    if (state.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error('Агент с таким именем уже есть');
    const a = { id: uid(), enabled: true, autonomy: 'edits', color: randomColor(), ...pick(b, AGENT_FIELDS), name };
    a.updatedAt = Date.now(); state.agents.push(a); syncSoon();
    if (!state.leaderId) state.leaderId = a.id;
    save(); pushState(); refreshAuth(a); try { syncSkills(a); syncMcp(a); } catch {} return a;
  },
  'PATCH /api/agents/:id': async (b, p) => {
    const a = agentById(p.id); if (!a) throw new Error('Нет такого агента');
    const upd = pick(b, AGENT_FIELDS);
    if (upd.name) {
      upd.name = String(upd.name).trim().replace(/\s+/g, '_');
      if (state.agents.some((x) => x.id !== a.id && x.name.toLowerCase() === upd.name.toLowerCase())) throw new Error('Имя занято');
    }
    if (upd.profileDir === '') upd.profileDir = undefined;
    const reAuth = upd.profileDir !== undefined && upd.profileDir !== a.profileDir;
    Object.assign(a, upd); a.updatedAt = Date.now(); syncSoon(); save(); pushState(); if (reAuth) refreshAuth(a); try { syncSkills(a); syncMcp(a); } catch {} return a;
  },
  'DELETE /api/agents/:id': async (b, p) => {
    state.agents = state.agents.filter((a) => a.id !== p.id);
    if (syncConnected()) { sync.tombstones[p.id] = Date.now(); saveSync(); syncSoon(); }
    for (const sk of state.skills) sk.agents = (sk.agents || []).filter((x) => x !== p.id);
    for (const m of state.mcp) m.agents = (m.agents || []).filter((x) => x !== p.id);
    if (state.leaderId === p.id) state.leaderId = state.agents[0]?.id || null;
    save(); pushState(); return { ok: true };
  },
  'POST /api/agents/:id/login': async (b, p) => {
    const a = agentById(p.id); if (!a) throw new Error('Нет такого агента');
    startLogin(a); return { ok: true };
  },
  'POST /api/agents/:id/login/input': async (b, p) => {
    const c = authSessions.get(p.id); if (!c) throw new Error('Вход уже завершён');
    c.stdin.write(String(b.text || '') + '\n'); return { ok: true };
  },
  'POST /api/agents/:id/login/cancel': async (b, p) => { cancelLogin(p.id); pushState(); return { ok: true }; },
  'POST /api/agents/:id/logout': async (b, p) => { const a = agentById(p.id); if (a) await logout(a); return { ok: true }; },
  'POST /api/agents/:id/auth': async (b, p) => { const a = agentById(p.id); if (a) await refreshAuth(a); return authStatus[p.id] || {}; },
  'POST /api/install/:provider': async (b, p) => { installProvider(p.provider, !!b.update); return { ok: true }; },
  'POST /api/open-path': async (b) => {
    const p = { data: DATA, projects: PROJECTS_DIR }[b.which]; if (!p) throw new Error('Неизвестная папка');
    fs.mkdirSync(p, { recursive: true });
    spawn(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
  'POST /api/models/refresh': async () => { await refreshAllModels(); return { ok: true }; },
  'POST /api/open-url': async (b) => { openExternal(String(b.url || '')); return { ok: true }; },
  'POST /api/quit': async () => { if (!EMBEDDED) setTimeout(shutdown, 100); return { ok: true }; },
  'GET /api/skills/:id': async (b, p) => {
    const sk = skillById(p.id); if (!sk) throw new Error('Нет такого скилла');
    return { ...sk, content: fs.readFileSync(path.join(SKILLS_DIR, sk.id, 'SKILL.md'), 'utf8'), files: listFiles(path.join(SKILLS_DIR, sk.id)) };
  },
  'POST /api/skills': async (b) => {
    const content = b.content || buildSkillMd(b.name, b.description, b.body);
    const sk = importSkillText(content, b.name, b.all !== false, b.agents);
    return sk;
  },
  'POST /api/skills/upload': async (b) => importUpload(b.files || [], b.all !== false, b.agents),
  'PATCH /api/skills/:id': async (b, p) => {
    const sk = skillById(p.id); if (!sk) throw new Error('Нет такого скилла');
    if (b.all !== undefined) sk.all = !!b.all;
    if (Array.isArray(b.agents)) sk.agents = b.agents.filter((id) => agentById(id));
    if (b.enabled !== undefined) sk.enabled = !!b.enabled;
    if (typeof b.content === 'string') {
      const meta = parseSkillMd(b.content);
      writeSkillMd(path.join(SKILLS_DIR, sk.id), meta, sk.id);
      sk.name = meta.name || sk.name; sk.description = meta.description || sk.description;
    }
    save(); syncAllSkills(); pushState(); return sk;
  },
  'DELETE /api/skills/:id': async (b, p) => {
    state.skills = state.skills.filter((x) => x.id !== p.id);
    fs.rmSync(path.join(SKILLS_DIR, p.id), { recursive: true, force: true });
    save(); syncAllSkills(); pushState(); return { ok: true };
  },
  'GET /api/mcp/presets': async () => MCP_PRESETS,
  'POST /api/mcp': async (b) => {
    let src = b;
    if (b.preset) { const pr = MCP_PRESETS.find((x) => x.key === b.preset); if (!pr) throw new Error('Нет такого шаблона'); src = { ...pr, description: pr.desc, ...b, preset: pr.key }; }
    const m = addMcp(src); m.preset = src.preset || null;
    state.mcpUpdatedAt = Date.now(); save(); syncAllMcp(); pushState(); syncSoon(); return redactMcp(m);
  },
  'POST /api/mcp/import': async (b) => { const added = importMcpJson(b.json, b.all !== false, b.agents); state.mcpUpdatedAt = Date.now(); save(); syncAllMcp(); pushState(); syncSoon(); return { added: added.map(redactMcp) }; },
  'POST /api/mcp/import-desktop': async (b) => {
    const f = DESKTOP_CFG();
    if (!fs.existsSync(f)) throw new Error('Не нашёл настройки Claude Desktop (' + f + ')');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j.mcpServers || !Object.keys(j.mcpServers).length) throw new Error('В Claude Desktop нет подключённых MCP-серверов');
    const fresh = Object.fromEntries(Object.entries(j.mcpServers).filter(([n]) => !state.mcp.some((x) => x.name.toLowerCase() === mcpName(n).toLowerCase())));
    if (!Object.keys(fresh).length) throw new Error('Все серверы из Claude Desktop уже добавлены');
    const added = importMcpJson({ mcpServers: fresh }, true, []); state.mcpUpdatedAt = Date.now(); save(); syncAllMcp(); pushState(); syncSoon(); return { added: added.map(redactMcp) };
  },
  'PATCH /api/mcp/:id': async (b, p) => {
    const m = mcpById(p.id); if (!m) throw new Error('Нет такого сервера');
    if (b.all !== undefined) m.all = !!b.all;
    if (Array.isArray(b.agents)) m.agents = b.agents.filter((id) => agentById(id));
    if (b.enabled !== undefined) m.enabled = !!b.enabled;
    if (b.config) {
      const n = normMcp(unmaskMcp(b.config, m), m);
      if (state.mcp.some((x) => x.id !== m.id && x.name.toLowerCase() === n.name.toLowerCase())) throw new Error('Сервер с таким именем уже есть');
      Object.keys(m).forEach((k) => { if (['command', 'args', 'env', 'url', 'headers'].includes(k)) delete m[k]; });
      Object.assign(m, n); m.tools = null;
    }
    state.mcpUpdatedAt = Date.now(); save(); syncAllMcp(); pushState(); syncSoon(); return redactMcp(m);
  },
  'DELETE /api/mcp/:id': async (b, p) => { state.mcp = state.mcp.filter((x) => x.id !== p.id); state.mcpUpdatedAt = Date.now(); save(); syncAllMcp(); pushState(); syncSoon(); return { ok: true }; },
  'POST /api/mcp/:id/test': async (b, p) => {
    const m = mcpById(p.id); if (!m) throw new Error('Нет такого сервера');
    const r = await testMcp(m);
    m.lastTest = { ok: r.ok, error: r.error || null, at: Date.now() };
    if (r.ok) m.tools = r.tools;
    save(); pushState(); return r;
  },
  'GET /api/sync/candidates': async () => cloudCandidates(),
  'POST /api/sync/connect': async (b) => connectSync(b),
  'POST /api/sync/disconnect': async () => { await disconnectSync(); return { ok: true }; },
  'POST /api/sync/accounts': async (b) => addAccount(b),
  'POST /api/sync/internet': async (b) => { setInternet(!!b.on); return { ok: true }; },
  'GET /api/sync/accounts/:id/code': async (b, p) => accountCode(p.id),
  'POST /api/sync/accounts/:id/revoke': async (b, p) => { await revokeAccount(p.id); return { ok: true }; },
  'POST /api/sync/accounts/:id/forget': async (b, p) => { await forgetAccount(p.id); return { ok: true }; },
  'POST /api/sync/access-log/clear': async () => { sync.accessLog = []; saveSync(); pushState(); return { ok: true }; },
  'POST /api/sync/now': async () => { await syncNow(); if (sync.lastError) throw new Error(sync.lastError); return syncPublic(); },
  'POST /api/sync/name': async (b) => { sync.deviceName = String(b.name || '').trim() || sync.deviceName; saveSync(); syncSoon(); pushState(); return { ok: true }; },
  'POST /api/sync/devices/:id/logout': async (b, p) => { await remoteLogout(p.id); return { ok: true }; },
  'POST /api/sync/devices/:id/forget': async (b, p) => { await forgetDevice(p.id); return { ok: true }; },
  'POST /api/sync/installer': async () => { makeInstaller(); return { ok: true }; },
  'POST /api/sync/dismiss': async () => { sync.removed = null; saveSync(); pushState(); return { ok: true }; },
  'POST /api/leader': async (b) => { state.leaderId = b.agentId || null; save(); pushState(); return { ok: true }; },
  'POST /api/settings': async (b) => {
    for (const k of Object.keys(state.settings)) if (b[k] !== undefined) state.settings[k] = Math.max(1, Number(b[k]) || state.settings[k]);
    save(); pushState(); return state.settings;
  },

  'POST /api/projects': async (b) => {
    const p = newProject(String(b.name || 'Новый проект'), b.workspace ? path.resolve(b.workspace) : null);
    p.goal = b.goal || '';
    state.projects.push(p); save(); pushState(); return p;
  },
  'PATCH /api/projects/:id': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    if (b.name) pr.name = b.name;
    if (b.goal !== undefined) pr.goal = b.goal;
    if (b.discuss !== undefined) pr.discuss = !!b.discuss;
    if (b.git !== undefined) pr.git = !!b.git;
    if (b.workspace && path.resolve(b.workspace) !== pr.workspace) { pr.workspace = path.resolve(b.workspace); pr.workspaceRel = null; fs.mkdirSync(pr.workspace, { recursive: true }); }
    save(); pushState(); return pr;
  },
  'DELETE /api/projects/:id': async (b, p) => {
    if (state.projects.length <= 1) throw new Error('Нельзя удалить последний проект');
    const pr = projectById(p.id); if (pr) stopProject(pr);
    state.projects = state.projects.filter((x) => x.id !== p.id); save(); pushState(); return { ok: true };
  },
  'POST /api/projects/:id/message': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    const text = String(b.text || '').trim(); if (!text) throw new Error('Пустое сообщение');
    if (!state.agents.some((a) => a.enabled)) throw new Error('Добавьте хотя бы одного агента');
    addMessage(pr, { from: 'user', text });
    startFromUser(pr, text);
    return { ok: true };
  },
  'POST /api/projects/:id/tasks': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    const owner = agentById(b.owner); if (!owner) throw new Error('Выберите исполнителя');
    const text = String(b.text || b.title || '').trim(); if (!text) throw new Error('Опишите задачу');
    const files = String(b.files || '').split(/[,;\n]/).map((x) => normPath(x.trim())).filter(Boolean);
    const t = newTask(pr, { text, owner: owner.id, files, createdBy: 'Пользователь' });
    addMessage(pr, { from: 'user', text: `@${owner.name}: ${text}${files.length ? ` [файлы: ${files.join(', ')}]` : ''}` });
    const r = getRun(pr.id); if (!r.active) { r.calls = 0; r.leaderRounds = 0; }
    enqueue(pr, { agentId: owner.id, task: text, from: 'Пользователь', taskId: t.id });
    pump(pr); return t;
  },
  'PATCH /api/projects/:id/tasks/:tid': async (b, p) => {
    const pr = projectById(p.id); const t = pr && taskById(pr, p.tid); if (!t) throw new Error('Нет задачи');
    if (b.status && STATUS_RU[b.status]) setTask(pr, t, b.status);
    save(); pushState(); return t;
  },
  'DELETE /api/projects/:id/tasks/:tid': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    pr.tasks = pr.tasks.filter((t) => t.id !== Number(p.tid));
    const r = getRun(pr.id); r.queue = r.queue.filter((q) => q.taskId !== Number(p.tid));
    save(); pushState(); return { ok: true };
  },
  'POST /api/projects/:id/tasks-clear': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    pr.tasks = b.all ? [] : pr.tasks.filter((t) => t.status !== 'done');
    save(); pushState(); return { ok: true };
  },
  'GET /api/projects/:id/memory': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    const f = ensureMemory(pr); return { content: fs.readFileSync(f, 'utf8'), path: f, mtime: fs.statSync(f).mtimeMs };
  },
  'PUT /api/projects/:id/memory': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    fs.writeFileSync(ensureMemory(pr), String(b.content || ''), 'utf8'); return { ok: true };
  },
  'POST /api/projects/:id/revert': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    if (getRun(pr.id).active) throw new Error('Сначала дождитесь окончания работы или остановите агентов');
    const sha = String(b.sha || '').replace(/[^0-9a-f]/gi, ''); if (!sha) throw new Error('Нет шага');
    await gitRevert(pr, sha);
    const m = pr.messages.find((x) => x.changes?.sha === sha); if (m) m.reverted = true;
    addMessage(pr, { from: 'system', text: `↩ Изменения шага ${sha}${m ? ` (${m.name})` : ''} отменены.` });
    save(); pushState(); return { ok: true };
  },
  'POST /api/projects/:id/stop': async (b, p) => { const pr = projectById(p.id); if (pr) stopProject(pr); return { ok: true }; },
  'POST /api/projects/:id/clear': async (b, p) => { const pr = projectById(p.id); if (pr) { pr.messages = []; save(); pushState(); } return { ok: true }; },
  'POST /api/projects/:id/open': async (b, p) => {
    const pr = projectById(p.id); if (!pr) throw new Error('Нет проекта');
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [pr.workspace], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
};
function randomColor() { const h = Math.floor(Math.random() * 360); return `hsl(${h} 65% 55%)`; }

function match(method, url) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/'), up = url.split('/');
    if (pp.length !== up.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i]);
      else if (pp[i] !== up[i]) { ok = false; break; }
    }
    if (ok) return [routes[key], params];
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  // только локальный доступ
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.writeHead(403); return res.end('local only'); }

  if (url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) { res.writeHead(403); return res.end('forbidden'); }
  if (url.startsWith('/api/') && req.method !== 'GET' && !/^application\/json/i.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end('json only'); }
  if (url.startsWith('/api/')) {
    const r = match(req.method, url);
    if (!r) return send(res, 404, { error: 'not found' });
    try { send(res, 200, await r[0](await body(req), r[1])); }
    catch (e) { send(res, 400, { error: e.message }); }
    return;
  }
  if (url === '/' || url === '/index.html') {
    const html = sea ? sea.getAsset('index.html', 'utf8') : fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  res.writeHead(404); res.end('404');
});

// ---------------------------------------------------------------- окно приложения
// Открываем интерфейс отдельным окном (режим приложения Edge/Chrome), без адресной строки.
function findBrowser() {
  if (process.platform !== 'win32') return null;
  const c = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return c.find((p) => fs.existsSync(p)) || null;
}
function openWindow() {
  const url = `http://localhost:${PORT}/`;
  const br = findBrowser();
  if (br) {
    spawn(br, [`--app=${url}`, `--user-data-dir=${path.join(DATA, 'window')}`, '--window-size=1400,900', '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' }).unref();
  } else {
    try { openExternal(url); } catch {}
  }
}

// Приложение закрывается само, когда закрыто его окно (и никто из агентов не работает).
let hadClient = false, idleSince = null;
setInterval(() => {
  if (NO_WINDOW) return;
  if (clients.size) { hadClient = true; idleSince = null; return; }
  if (!hadClient || busy.size || authSessions.size || installing.size) { idleSince = null; return; }
  idleSince = idleSince || Date.now();
  if (Date.now() - idleSince > 15000) shutdown();
}, 3000).unref();

function shutdown() {
  stopTunnel();
  for (const b of busy.values()) killTree(b.child);
  for (const c of authSessions.values()) killTree(c);
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
  process.exit(0);
}

if (!EMBEDDED) server.on('error', (e) => {
  // уже запущено — просто показываем окно существующего экземпляра
  if (e.code === 'EADDRINUSE') { openWindow(); setTimeout(() => process.exit(0), 1500); }
  else { console.error(e); process.exit(1); }
});
function afterStart() {
  try { syncAllSkills(); } catch (e) { console.error('skills', e.message); }
  upgradeKeyProtection();
  if (sync.mode === 'server' && sync.internet) { providerIdx = sync.tunnelProvider || 0; setTimeout(startTunnel, 1500); }
  if (sync.mode === 'server' && getKey()) startHubServer().catch((e) => console.error('hub', e.message));
  (syncConnected() ? syncNow() : Promise.resolve()).catch(() => {}).finally(() => Promise.all(state.agents.map(refreshAuth)).then(refreshAllModels));
}
if (!EMBEDDED) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Agent Hub запущен: http://localhost:${PORT}\n`);
    if (!NO_WINDOW) openWindow();
    afterStart();
  });
  process.on('SIGINT', shutdown);
}
// API для приложения: запускаем на свободном порту и отдаём адрес
module.exports = {
  start: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { afterStart(); resolve(`http://localhost:${server.address().port}/`); });
  }),
  isBusy: () => busy.size > 0 || authSessions.size > 0 || installing.size > 0,
  shutdown: () => {
    stopTunnel();
    for (const b of busy.values()) killTree(b.child);
    for (const c of authSessions.values()) killTree(c);
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
  },
};
