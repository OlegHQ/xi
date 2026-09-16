import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  OracleFixture,
  OracleFixtureResult,
  OracleJson,
  OracleManifest,
  OracleSnapshot,
  OracleUiResult,
} from './types';

const oracleDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(oracleDirectory, '../..');
export const artifactRoot = resolve(projectRoot, '.artifacts/oracle');
const manifestPath = join(oracleDirectory, 'manifest.json');
const maxProcessOutputBytes = 8 * 1024 * 1024;

export interface OracleUiRunOptions {
  readonly processTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  /** Defaults to the fixture's complete first line. */
readonly readinessMarker?: string;
}

const luaHarness = String.raw`
local function copy_lines(lines)
  local result = {}
  for index, line in ipairs(lines) do result[index] = line end
  return result
end

local function install_fixture_clipboard(spec)
  local state = {
    ['+'] = { lines = { '' }, type = 'v' },
    ['*'] = { lines = { '' }, type = 'v' }
  }
  local function seed(name, value)
    if type(value) ~= 'table' or type(value.lines) ~= 'table' or type(value.type) ~= 'string' then return end
    state[name] = { lines = copy_lines(value.lines), type = value.type }
  end
  seed('+', spec.clipboard and spec.clipboard.plus)
  seed('*', spec.clipboard and spec.clipboard.star)
  local function copy(name, lines, regtype)
    state[name] = { lines = copy_lines(lines), type = regtype }
  end
  local function paste(name)
    local value = state[name] or { lines = { '' }, type = 'v' }
    return copy_lines(value.lines), value.type
  end
  vim.g.clipboard = {
    name = 'xi-oracle-fixture-local',
    cache_enabled = 0,
    copy = {
      ['+'] = function(lines, regtype) copy('+', lines, regtype) end,
      ['*'] = function(lines, regtype) copy('*', lines, regtype) end
    },
    paste = {
      ['+'] = function() return paste('+') end,
      ['*'] = function() return paste('*') end
    }
  }
  vim.fn.setreg('+', state['+'].lines, state['+'].type)
  vim.fn.setreg('*', state['*'].lines, state['*'].type)
end

local function capture(label)
  local position = vim.fn.getpos('.')
  local view = vim.fn.winsaveview()
  local mode = vim.api.nvim_get_mode()
  local screen = vim.fn.screenpos(0, position[2], math.max(position[3], 1))
  local option_names = {
    'ambiwidth', 'backspace', 'cpoptions', 'endofline', 'expandtab', 'fileformat',
    'ignorecase', 'iskeyword', 'joinspaces', 'magic', 'nrformats', 'scrolloff',
    'selection', 'shiftwidth', 'sidescrolloff', 'smartcase', 'startofline',
    'tabstop', 'timeout', 'timeoutlen', 'virtualedit', 'whichwrap', 'wrap', 'wrapscan'
  }
  local options = {}
  for _, name in ipairs(option_names) do
    local ok, value = pcall(vim.api.nvim_get_option_value, name, {})
    if ok then options[name] = value end
  end
  local register_names = { '"', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '-', 'a', 'A', 'z', 'Z', '+', '*' }
  local registers = {}
  for _, name in ipairs(register_names) do
    local ok, contents, kind = pcall(function()
      return vim.fn.getreg(name, 1, true), vim.fn.getregtype(name)
    end)
    if ok then registers[name] = { lines = contents, type = kind } end
  end
  local marks = {}
  for _, name in ipairs({ '.', '^', '[', ']', '<', '>', '"' }) do
    local ok, value = pcall(vim.fn.getpos, name)
    if ok then marks[name] = value end
  end
  local jump_list = { entries = {}, index = 0 }
  local jump_ok, jump_entries, jump_index = pcall(vim.fn.getjumplist)
  if jump_ok then jump_list = { entries = jump_entries, index = jump_index } end
  local change_list = { entries = {}, index = 0 }
  local change_ok, change_entries, change_index = pcall(vim.fn.getchangelist)
  if change_ok then change_list = { entries = change_entries, index = change_index } end

  return {
    label = label,
    lines = vim.api.nvim_buf_get_lines(0, 0, -1, true),
    cursor = {
      line = position[2],
      byteColumn = position[3],
      coladd = position[4],
      virtualColumn = vim.fn.virtcol('.'),
      desiredColumn = view.curswant,
      screenRow = screen.row,
      screenColumn = screen.col
    },
    mode = mode.mode,
    blocking = mode.blocking,
    geometry = {
      columns = vim.o.columns,
      lines = vim.o.lines,
      windowWidth = vim.api.nvim_win_get_width(0),
      windowHeight = vim.api.nvim_win_get_height(0)
    },
    view = view,
    options = options,
    buffer = {
      name = vim.api.nvim_buf_get_name(0),
      endOfLine = vim.bo.endofline,
      fileFormat = vim.bo.fileformat,
      fileEncoding = vim.bo.fileencoding,
      bomb = vim.bo.bomb,
      modified = vim.bo.modified,
      modifiable = vim.bo.modifiable,
      filetype = vim.bo.filetype
    },
    registers = registers,
    marks = marks,
    jumpList = jump_list,
    changeList = change_list,
    search = {
      pattern = vim.fn.getreg('/'),
      forward = vim.v.searchforward,
      highlighting = vim.v.hlsearch
    },
    commandLine = vim.fn.getcmdline(),
    error = vim.v.errmsg
  }
end

local terminal_key_names = {
  Nul = true, BS = true, Tab = true, NL = true, FF = true, CR = true,
  Return = true, Enter = true, Esc = true, Space = true, lt = true,
  Bslash = true, Bar = true, Del = true, Delete = true, Insert = true,
  Up = true, Down = true, Left = true, Right = true, Home = true, End = true,
  PageUp = true, PageDown = true, KEnter = true, KHome = true, KEnd = true,
  KPageUp = true, KPageDown = true, KPlus = true, KMinus = true,
  KDivide = true, KMultiply = true, KPoint = true, Undo = true,
  LeftMouse = true, RightMouse = true
}

local function is_terminal_key_name(name)
  if terminal_key_names[name] then return true end
  if name:match('^K[0-9]$') then return true end
  local function_key = name:match('^[Ff](%d+)$')
  if function_key then
    local number = tonumber(function_key)
    return number ~= nil and number >= 1 and number <= 37
  end
  local modifier, remainder = name:match('^([CSMAD])%-(.+)$')
  if modifier then
    return terminal_key_names[remainder] == true
      or remainder:match('^K[0-9]$') ~= nil
      or remainder:match('^[Ff]%d+$') ~= nil
      or (#remainder == 1 and remainder:byte(1) >= 0x21 and remainder:byte(1) <= 0x7e)
      or is_terminal_key_name(remainder)
  end
  return #name == 1 and name:byte(1) >= 0x21 and name:byte(1) <= 0x7e
end

-- Scan ASCII delimiters in the UTF-8 byte string and pass only recognized
-- terminal notation tokens through nvim_replace_termcodes. Literal runs retain
-- their original bytes, so supplementary scalars are not reinterpreted.
local function expand_terminal_key_notation(input)
  local output = {}
  local index = 1
  while index <= #input do
    local opening = input:find('<', index, true)
    if not opening then
      table.insert(output, input:sub(index))
      break
    end
    if opening > index then table.insert(output, input:sub(index, opening - 1)) end
    local closing = input:find('>', opening + 1, true)
    if not closing then
      table.insert(output, input:sub(opening))
      break
    end
    local token = input:sub(opening, closing)
    local name = input:sub(opening + 1, closing - 1)
    if is_terminal_key_name(name) then
      table.insert(output, vim.api.nvim_replace_termcodes(token, true, false, true))
      index = closing + 1
    else
      -- Treat this delimiter as literal and resume scanning so a later
      -- recognized token is still expanded (for example, <<Esc>).
      table.insert(output, '<')
      index = opening + 1
    end
  end
  return table.concat(output)
end

local function execute()
  local spec = vim.json.decode(table.concat(vim.fn.readfile(vim.env.XI_ORACLE_SPEC, 'b'), '\n'))
  install_fixture_clipboard(spec)
  vim.o.modeline = false
  vim.o.loadplugins = false
  vim.o.number = false
  vim.o.relativenumber = false
  vim.o.signcolumn = 'no'
  vim.o.foldcolumn = '0'
  vim.o.foldenable = false
  vim.o.laststatus = 0
  vim.o.ruler = false
  vim.o.showcmd = false
  vim.o.wrap = true
  vim.o.ambiwidth = 'single'
  vim.o.encoding = 'utf-8'
  vim.o.filetype = ''
  vim.bo.filetype = ''

  for name, value in pairs(spec.options or {}) do
    vim.o[name] = value
  end
  if type(spec.searchPattern) == 'string' then
    vim.fn.setreg('/', spec.searchPattern)
    vim.v.hlsearch = 1
  end
  if type(spec.bufferPath) == 'string' then
    vim.cmd('edit ' .. vim.fn.fnameescape(spec.bufferPath))
  else
    vim.api.nvim_buf_set_lines(0, 0, -1, true, #spec.lines == 0 and { '' } or spec.lines)
  end
  vim.bo.endofline = spec.endOfLine ~= false
  vim.bo.fileformat = spec.fileFormat or 'unix'
  vim.bo.fileencoding = 'utf-8'
  vim.bo.bomb = false
  vim.bo.filetype = ''
  vim.bo.modified = false
  if type(spec.searchPattern) == 'string' then
    vim.fn.setreg('/', spec.searchPattern)
    vim.v.hlsearch = 1
  end
  local cursor = spec.cursor or { line = 1, byteColumn0 = 0 }
  vim.api.nvim_win_set_cursor(0, { cursor.line, cursor.byteColumn0 })

  for _, mapping in ipairs(spec.mappings or {}) do
    vim.keymap.set(mapping.mode, mapping.lhs, mapping.rhs, {
      remap = mapping.remap == true,
      nowait = mapping.nowait == true,
      silent = true
    })
  end

  local snapshots = {}
  for _, step in ipairs(spec.steps) do
    if step.keys then
      local keys = expand_terminal_key_notation(step.keys)
      local flags = step.barrier == false and 'mt' or 'xt'
      vim.fn.feedkeys(keys, flags)
    elseif step.drain then
      vim.fn.feedkeys('', 'x')
    end
    table.insert(snapshots, capture(step.label))
  end
  return { ok = true, fixtureId = spec.id, snapshots = snapshots }
end

local ok, result = xpcall(execute, debug.traceback)
if not ok then result = { ok = false, error = tostring(result) } end
vim.fn.writefile({ vim.json.encode(result) }, vim.env.XI_ORACLE_RESULT, 'b')
vim.cmd('qa!')
`;

export async function readManifest(): Promise<OracleManifest> {
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.oracle) || !isRecord(value.oracle.asset)) {
    throw new Error(`Invalid Neovim oracle manifest: ${manifestPath}`);
  }
  return value as unknown as OracleManifest;
}

export function defaultOraclePath(manifest: OracleManifest): string {
  return resolve(artifactRoot, manifest.oracle.binaryPath);
}

export async function verifyOracleBundle(binaryOverride?: string): Promise<{
  readonly manifest: OracleManifest;
  readonly binaryPath: string;
  readonly runtimePath: string;
}> {
  const manifest = await readManifest();
  const binaryPath = resolve(binaryOverride ?? defaultOraclePath(manifest));
  const executable = await readFile(binaryPath).catch(() => {
    throw new Error(`pinned-neovim-oracle-missing: ${binaryPath}; run bun run oracle:fetch`);
  });
  const binaryHash = hash(executable);
  if (binaryHash !== manifest.oracle.binarySha256) {
    throw new Error(`neovim-binary-hash-mismatch: expected ${manifest.oracle.binarySha256}, observed ${binaryHash}`);
  }

  const versionRoot = await mkdtemp(join(tmpdir(), 'xi-nvim-version-'));
  let versionLines: string[];
  try {
    const output = await runProcess(binaryPath, ['--version'], await isolatedEnvironment(versionRoot));
    versionLines = output.stdout.trim().split(/\r?\n/);
  } finally {
    await rm(versionRoot, { recursive: true, force: true });
  }
  assertVersionMatches(manifest.oracle.versionOutput, versionLines);

  const runtimePath = resolve(artifactRoot, manifest.oracle.runtimePath);
  const docsPath = resolve(runtimePath, manifest.oracle.runtimeDocs.path);
  const docFiles = await listFiles(docsPath);
  const docsHash = await directoryDigest(docsPath, docFiles);
  assertRuntimeDocsMatch(manifest.oracle.runtimeDocs.fileCount, manifest.oracle.runtimeDocs.sha256, docFiles.length, docsHash);
  for (const [relativePath, expectedHash] of Object.entries(manifest.oracle.runtimeDocs.criticalFiles)) {
    const actualHash = hash(await readFile(resolve(docsPath, relativePath)));
    if (actualHash !== expectedHash) {
      throw new Error(`neovim-runtime-file-hash-mismatch: ${relativePath} expected ${expectedHash}, observed ${actualHash}`);
    }
  }
  return { manifest, binaryPath, runtimePath };
}

export async function runOracleFixture(
  fixture: OracleFixture,
  binaryPath: string,
  timeoutMs = 15_000,
): Promise<OracleFixtureResult> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xi-nvim-oracle-'));
  try {
    const home = join(temporaryRoot, 'home');
    await Promise.all([
      mkdir(join(home, 'config'), { recursive: true }),
      mkdir(join(home, 'data'), { recursive: true }),
      mkdir(join(home, 'state'), { recursive: true }),
      mkdir(join(home, 'cache'), { recursive: true }),
      mkdir(join(temporaryRoot, 'runtime'), { recursive: true }),
    ]);
    const specPath = join(temporaryRoot, 'fixture.json');
    const luaPath = join(temporaryRoot, 'harness.lua');
    const vimPath = join(temporaryRoot, 'run.vim');
    const resultPath = join(temporaryRoot, 'result.json');
    let fixtureSpec: OracleFixture | (OracleFixture & { readonly bufferPath: string }) = fixture;
    if (fixture.initialFile !== undefined || fixture.hostFiles !== undefined) {
      const initialFile = fixture.initialFile ?? 'main.txt';
      const files = [{ path: initialFile, lines: fixture.lines }, ...(fixture.hostFiles ?? [])];
      const paths = new Set<string>();
      for (const file of files) {
        if (!isSafeFixturePath(file.path) || paths.has(file.path)) throw new Error(`oracle-host-file-invalid: ${fixture.id}: ${file.path}`);
        paths.add(file.path);
        const absolute = resolve(temporaryRoot, file.path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, `${file.lines.join('\n')}\n`, 'utf8');
      }
      const initialPath = resolve(temporaryRoot, initialFile);
      const { initialFile: _initialFile, hostFiles: _hostFiles, ...withoutHostFiles } = fixture;
      fixtureSpec = { ...withoutHostFiles, bufferPath: initialPath };
    }
    if (fixture.rawBufferBytes !== undefined) {
      if (!Array.isArray(fixture.rawBufferBytes) || fixture.rawBufferBytes.some((value) =>
        !Number.isSafeInteger(value) || value < 0 || value > 255)) {
        throw new Error(`oracle-fixture-raw-buffer-bytes-invalid: ${fixture.id}`);
      }
      const bufferPath = join(temporaryRoot, 'buffer.bin');
      await writeFile(bufferPath, Buffer.from(fixture.rawBufferBytes));
      const { rawBufferBytes: _rawBufferBytes, ...withoutBytes } = fixture;
      fixtureSpec = { ...withoutBytes, bufferPath };
    }
    await writeFile(specPath, JSON.stringify(fixtureSpec), 'utf8');
    await writeFile(luaPath, luaHarness, 'utf8');
    await writeFile(vimPath, 'lua dofile(vim.env.XI_ORACLE_LUA)\n', 'utf8');
    const environment = await isolatedEnvironment(temporaryRoot);
    environment.XI_ORACLE_SPEC = specPath;
    environment.XI_ORACLE_LUA = luaPath;
    environment.XI_ORACLE_RESULT = resultPath;
    environment.TERM = 'xterm-256color';

    const child = await runProcess(binaryPath, [
      '--headless', '--clean', '-u', 'NONE', '-i', 'NONE', '-n', '-N', '--noplugin', '-S', vimPath,
    ], environment, timeoutMs, temporaryRoot);
    await assertNoSystemClipboardInvocation(temporaryRoot);
    const resultText = await readFile(resultPath, 'utf8').catch(() => {
      throw new Error(`oracle-produced-no-snapshot: fixture=${fixture.id}; exit=${child.code}; stderr=${child.stderr.trim()}`);
    });
    const value: unknown = JSON.parse(resultText);
    if (!isRecord(value) || value.ok !== true || !Array.isArray(value.snapshots)) {
      const error = isRecord(value) && typeof value.error === 'string' ? value.error : JSON.stringify(value);
      throw new Error(`oracle-fixture-failed: fixture=${fixture.id}; ${error}`);
    }
    return {
      fixtureId: fixture.id,
      snapshots: value.snapshots as OracleSnapshot[],
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runUiOracleFixture(
  fixture: OracleFixture,
  binaryPath: string,
  options: OracleUiRunOptions = {},
): Promise<OracleUiResult> {
  const processTimeoutMs = options.processTimeoutMs ?? 15_000;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 8_000;
  const readinessMarker = options.readinessMarker ?? fixture.lines[0] ?? '';
  if (!Number.isSafeInteger(processTimeoutMs) || processTimeoutMs < 1
    || !Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs < 1
    || typeof readinessMarker !== 'string') {
    throw new Error(`pty-oracle-invalid-run-options: ${fixture.id}`);
  }
  const inputStep = fixture.steps.find((step) => step.keys !== undefined && step.barrier !== false);
  if (inputStep?.keys === undefined) throw new Error(`pty-fixture-has-no-drained-key-input: ${fixture.id}`);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xi-nvim-pty-oracle-'));
  const transcriptDirectory = join(artifactRoot, 'pty');
  await mkdir(transcriptDirectory, { recursive: true });
  const resultPath = join(temporaryRoot, 'ui-result.json');
  const transcriptPath = join(transcriptDirectory, `${fixture.id}.ansi`);
  try {
    const environment = await isolatedEnvironment(temporaryRoot);
    const child = await runProcess('python3', [
      join(oracleDirectory, 'pty-ui.py'),
      binaryPath,
      JSON.stringify(fixture),
      inputStep.keys,
      resultPath,
      transcriptPath,
      String(readinessTimeoutMs),
      readinessMarker,
    ], environment, processTimeoutMs);
    await assertNoSystemClipboardInvocation(temporaryRoot);
    const output = await readFile(resultPath, 'utf8').catch(() => {
      throw new Error(`pty-oracle-produced-no-snapshot: fixture=${fixture.id}; exit=${child.code}; stderr=${child.stderr.trim()}`);
    });
    const result: unknown = JSON.parse(output);
    if (!isRecord(result) || result.ok !== true || !isRecord(result.snapshot) || !isRecord(result.pty)) {
      const reason = isRecord(result) && typeof result.error === 'string' ? result.error : JSON.stringify(result);
      throw new Error(`pty-oracle-fixture-failed: fixture=${fixture.id}; ${reason}`);
    }
    if (result.fixtureId !== fixture.id || typeof result.terminalRestored !== 'boolean') {
      throw new Error(`pty-oracle-result-invalid: fixture=${fixture.id}`);
    }
    return {
      fixtureId: fixture.id,
      snapshot: result.snapshot as unknown as OracleSnapshot,
      pty: result.pty as unknown as { readonly rows: number; readonly columns: number },
      terminalRestored: result.terminalRestored,
      transcriptPath,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function checkNoRuntimeOracleDependency(): Promise<void> {
  const packageValue: unknown = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  if (!isRecord(packageValue)) throw new Error('runtime-boundary-check-invalid-package-json');
  for (const sectionName of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const section = packageValue[sectionName];
    if (isRecord(section)) {
      const offender = Object.keys(section).find((name) => /neovim|\bnvim\b|vim-oracle/i.test(name));
      if (offender) throw new Error(`runtime-oracle-dependency-forbidden: ${sectionName}.${offender}`);
    }
  }
  for (const rootName of ['apps', 'packages']) {
    const root = resolve(projectRoot, rootName);
    const paths = await listFiles(root, true);
    for (const filePath of paths) {
      if (!/\.(?:[cm]?[jt]sx?)$/i.test(filePath)) continue;
      const source = await readFile(filePath, 'utf8');
      if (/(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*(?:neovim|nvim|tests\/oracle)/i.test(source)) {
        throw new Error(`runtime-oracle-import-forbidden: ${filePath}`);
      }
      if (/\b(?:spawn|execFile|exec|fork)\s*\(\s*['"](?:nvim|neovim)(?:\.exe)?['"]/i.test(source)) {
        throw new Error(`runtime-neovim-process-forbidden: ${filePath}`);
      }
    }
  }
}

export function compareSnapshot(expected: Readonly<Record<string, unknown>>, actual: unknown): readonly string[] {
  const differences: string[] = [];
  compareValue('$', expected, actual, differences);
  return differences;
}

export function assertVersionMatches(expected: readonly string[], observed: readonly string[]): void {
  if (!sameStrings(observed, expected)) {
    throw new Error(`neovim-version-output-mismatch: expected ${expected.join(' | ')}, observed ${observed.join(' | ')}`);
  }
}

export function assertRuntimeDocsMatch(
  expectedFileCount: number,
  expectedHash: string,
  observedFileCount: number,
  observedHash: string,
): void {
  if (observedFileCount !== expectedFileCount) {
    throw new Error(`neovim-runtime-doc-count-mismatch: expected ${expectedFileCount}, observed ${observedFileCount}`);
  }
  if (observedHash !== expectedHash) {
    throw new Error(`neovim-runtime-doc-hash-mismatch: expected ${expectedHash}, observed ${observedHash}`);
  }
}

export function snapshotJson(value: OracleSnapshot): OracleJson {
  return value as unknown as OracleJson;
}

async function isolatedEnvironment(temporaryRoot: string): Promise<NodeJS.ProcessEnv> {
  const home = join(temporaryRoot, 'home');
  const bin = join(temporaryRoot, 'clipboard-bin');
  const sentinel = join(temporaryRoot, 'clipboard-provider-invoked');
  const script = '#!/bin/sh\nprintf "%s" "$0" > "$XI_ORACLE_CLIPBOARD_SENTINEL"\nexit 127\n';
  await Promise.all([
    mkdir(join(home, 'config'), { recursive: true }),
    mkdir(join(home, 'data'), { recursive: true }),
    mkdir(join(home, 'state'), { recursive: true }),
    mkdir(join(home, 'cache'), { recursive: true }),
    mkdir(join(temporaryRoot, 'runtime'), { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  for (const command of ['xclip', 'xsel', 'wl-copy', 'wl-paste', 'pbcopy', 'pbpaste', 'lemonade', 'win32yank.exe', 'putclip', 'getclip']) {
    await writeFile(join(bin, command), script, 'utf8');
    await chmod(join(bin, command), 0o700);
  }
  await chmod(join(temporaryRoot, 'runtime'), 0o700);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_RUNTIME_DIR: join(temporaryRoot, 'runtime'),
    NVIM_APPNAME: 'xi-oracle-no-config',
    VIMINIT: '',
    EXINIT: '',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: temporaryRoot,
    PATH: `${bin}${process.env.PATH === undefined ? '' : `:${process.env.PATH}`}`,
    XI_ORACLE_CLIPBOARD_SENTINEL: sentinel,
  };
  for (const key of ['MYVIMRC', 'VIM', 'VIMRC', 'VIMRUNTIME', 'LUA_PATH', 'LUA_CPATH', 'NVIM_LISTEN_ADDRESS', 'NVIM_LOG_FILE']) delete environment[key];
  return environment;
}

async function assertNoSystemClipboardInvocation(temporaryRoot: string): Promise<void> {
  const sentinel = join(temporaryRoot, 'clipboard-provider-invoked');
  const invocation = await readFile(sentinel, 'utf8').catch(() => '');
  if (invocation !== '') throw new Error(`oracle-system-clipboard-invoked: ${invocation}`);
}

function runProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
  cwd = projectRoot,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`oracle-process-timeout: ${command} ${args.join(' ')} (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxProcessOutputBytes) {
        child.kill('SIGKILL');
        clearTimeout(timer);
        rejectPromise(new Error(`oracle-process-output-limit-exceeded: ${maxProcessOutputBytes}`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxProcessOutputBytes) {
        child.kill('SIGKILL');
        clearTimeout(timer);
        rejectPromise(new Error(`oracle-process-output-limit-exceeded: ${maxProcessOutputBytes}`));
        return;
      }
      stderr.push(chunk);
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code !== 0) {
        rejectPromise(new Error(`oracle-process-failed: exit=${code}; stderr=${result.stderr.trim()}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function listFiles(root: string, missingIsEmpty = false): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (missingIsEmpty && isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    if (entry.isFile()) return [path];
    return [];
  }));
  return paths.flat().sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function directoryDigest(root: string, paths: readonly string[]): Promise<string> {
  const digest = createHash('sha256');
  for (const filePath of paths) {
    const relative = filePath.slice(root.length + 1).split('\\').join('/');
    const fileHash = hash(await readFile(filePath));
    digest.update(relative);
    digest.update('\0');
    digest.update(fileHash);
    digest.update('\n');
  }
  return digest.digest('hex');
}

function compareValue(path: string, expected: unknown, actual: unknown, differences: string[]): void {
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      differences.push(`${path}: expected object, received ${describe(actual)}`);
      return;
    }
    for (const [key, value] of Object.entries(expected)) compareValue(`${path}.${key}`, value, actual[key], differences);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      differences.push(`${path}: expected array, received ${describe(actual)}`);
      return;
    }
    if (expected.length !== actual.length) differences.push(`${path}.length: expected ${expected.length}, received ${actual.length}`);
    const sharedLength = Math.min(expected.length, actual.length);
    for (let index = 0; index < sharedLength; index += 1) compareValue(`${path}[${index}]`, expected[index], actual[index], differences);
    return;
  }
  if (!Object.is(expected, actual)) differences.push(`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describe(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeFixturePath(value: string): boolean {
  return value.length > 0 && !value.startsWith('/') && !value.includes('\0') && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
