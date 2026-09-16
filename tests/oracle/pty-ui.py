#!/usr/bin/env python3
"""Run one pinned Neovim fixture through a real PTY and retain its terminal stream."""

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path


ANSI_CSI_SEQUENCE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_OSC_SEQUENCE = re.compile(rb"\x1b\][^\x07]*(?:\x07|\x1b\\)")
TERMINAL_QUERY_RESPONSES = (
    (b"\x1b[5n", b"\x1b[0n"),
    (b"\x1b[6n", b"\x1b[1;1R"),
    (b"\x1b[c", b"\x1b[?1;2c"),
    (b"\x1b[?69$p", b"\x1b[?69;2$y"),
    (b"\x1b[?2026$p", b"\x1b[?2026;2$y"),
    (b"\x1b[?2027$p", b"\x1b[?2027;2$y"),
    (b"\x1b[?2031$p", b"\x1b[?2031;2$y"),
    (b"\x1b[?2048$p", b"\x1b[?2048;2$y"),
    (b"\x1b[?u", b"\x1b[?0u"),
    (b"\x1b]11;?\x07", b"\x1b]11;rgb:1414/1616/1b1b\x07"),
)
terminal_query_pending = bytearray()


def visible_utf8(data: bytes) -> str | None:
    """Return printable terminal text only when the accumulated bytes are valid UTF-8."""
    without_osc = ANSI_OSC_SEQUENCE.sub(b"", data)
    without_csi = ANSI_CSI_SEQUENCE.sub(b"", without_osc)
    printable = bytes(
        byte for byte in without_csi
        if byte == 0x0A or byte == 0x09 or (byte >= 0x20 and byte != 0x7F)
    )
    try:
        return printable.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        # In particular, do not treat a chunk ending in a partial scalar as text.
        return None


def contains_visible_marker(data: bytes | bytearray, marker: str) -> bool:
    if marker == "":
        return True
    text = visible_utf8(bytes(data))
    if text is None:
        return False
    # PTY redraws may reposition the cursor between cells. Keep every marker
    # scalar in order while tolerating horizontal cell padding in the stream.
    pattern = r"[ \t]*".join(
        r"[ \t]+" if character in " \t" else re.escape(character)
        for character in marker
    )
    return re.search(pattern, text) is not None


def terminal_restored(transcript: bytes | bytearray) -> bool:
    return b"\x1b[?1049l" in transcript and b"\x1b[?25h" in transcript


def main() -> int:
    if len(sys.argv) != 8:
        raise RuntimeError("usage: pty-ui.py BINARY FIXTURE_JSON KEYS RESULT_PATH TRANSCRIPT_PATH READINESS_TIMEOUT_MS READINESS_MARKER")
    binary, fixture_json, keys, result_arg, transcript_arg, readiness_timeout_arg, readiness_marker = sys.argv[1:]
    readiness_timeout = int(readiness_timeout_arg) / 1000.0
    if readiness_timeout <= 0:
        raise RuntimeError("pty-oracle-invalid-readiness-timeout")
    result_path = Path(result_arg)
    transcript_path = Path(transcript_arg)
    fixture = json.loads(fixture_json)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_path.parent.mkdir(parents=True, exist_ok=True)

    options = fixture.get("options", {})
    columns = int(options.get("columns", 80))
    rows = int(options.get("lines", 24))
    temporary_root = Path(os.environ["HOME"]).parent
    spec_path = temporary_root / "pty-fixture.json"
    setup_lua_path = temporary_root / "pty-setup.lua"
    setup_vim_path = temporary_root / "pty-setup.vim"
    spec_path.write_text(json.dumps(fixture), encoding="utf-8")
    setup_lua_path.write_text(lua_setup(), encoding="utf-8")
    setup_vim_path.write_text("lua dofile(vim.env.XI_ORACLE_SETUP)\n", encoding="utf-8")

    environment = os.environ.copy()
    environment.update(
        {
            "TERM": "xterm-256color",
            "XI_ORACLE_SPEC": str(spec_path),
            "XI_ORACLE_RESULT": str(result_path),
            "XI_ORACLE_SETUP": str(setup_lua_path),
        }
    )
    master_fd, slave_fd = pty.openpty()
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    process = None
    transcript = bytearray()
    try:
        process = subprocess.Popen(
            [binary, "--clean", "-u", "NONE", "-i", "NONE", "-n", "-N", "--noplugin", "-S", str(setup_vim_path)],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=str(temporary_root),
            env=environment,
            close_fds=True,
            start_new_session=True,
        )
        os.close(slave_fd)
        slave_fd = -1

        wait_for(
            process,
            master_fd,
            transcript,
            lambda data: b"\x1b[?1049h" in data and contains_visible_marker(data, readiness_marker),
            readiness_timeout,
        )
        # The first terminal redraw can precede Neovim's initial cursor-view
        # reconciliation. Restore the deterministic initial topline that Vim
        # uses once the cursor is made visible, then deliver fixture input in
        # a separate write.
        cursor_line = int((fixture.get("cursor") or {}).get("line", 1))
        window_height = max(1, rows - 1)
        initial_topline = max(1, cursor_line - window_height + 1)
        view_command = f":call winrestview({{\'topline\':{initial_topline}}})\r".encode()
        os.write(master_fd, view_command)
        time.sleep(0.05)
        read_available(master_fd, transcript)
        os.write(master_fd, encode_keys(keys) + b":XiOracleCapture\r")
        wait_for(process, master_fd, transcript, lambda _data: result_path.is_file(), 8.0)
        time.sleep(0.05)
        os.write(master_fd, b":qa!\r")
        wait_for_exit(process, master_fd, transcript, 8.0)
        transcript_path.write_bytes(transcript)

        result = json.loads(result_path.read_text(encoding="utf-8"))
        if not result.get("ok"):
            raise RuntimeError(f"snapshot-capture-failed: {result.get('error')}")
        if process.returncode != 0:
            raise RuntimeError(f"neovim-pty-exit-nonzero: {process.returncode}")
        restored = terminal_restored(transcript)
        if not restored:
            raise RuntimeError("neovim-pty-terminal-state-not-restored")
        result["terminalRestored"] = restored
        result["pty"] = {"rows": rows, "columns": columns}
        result["transcriptPath"] = str(transcript_path)
        result_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(f"pty={rows}x{columns} terminal_restored=true transcript={transcript_path}")
        return 0
    except Exception as error:  # the parent records the detailed failure and keeps the release gate red
        restored = restore_child_terminal(process, master_fd, transcript)
        error_text = str(error) if restored else f"{error}; terminal-restore-not-observed"
        transcript_path.write_bytes(transcript)
        result_path.write_text(json.dumps({"ok": False, "error": error_text, "terminalRestored": restored}), encoding="utf-8")
        print(f"pty-oracle-error: {error_text}", file=sys.stderr)
        return 1
    finally:
        if process is not None and process.poll() is None:
            terminate_child(process)
            read_available(master_fd, transcript)
            transcript_path.write_bytes(transcript)
        if slave_fd >= 0:
            os.close(slave_fd)
        os.close(master_fd)


def wait_for(process, master_fd, transcript, predicate, timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate(transcript):
            return
        if process.poll() is not None:
            raise RuntimeError(f"neovim-pty-exited-before-marker: {process.returncode}")
        readable, _, _ = select.select([master_fd], [], [], 0.05)
        if readable:
            read_available(master_fd, transcript)
    raise RuntimeError("neovim-pty-marker-timeout")


def wait_for_exit(process, master_fd, transcript, timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            read_available(master_fd, transcript)
            return
        readable, _, _ = select.select([master_fd], [], [], 0.05)
        if readable:
            read_available(master_fd, transcript)
    raise RuntimeError("neovim-pty-shutdown-timeout")


def restore_child_terminal(process, master_fd, transcript):
    if process is None:
        return terminal_restored(transcript)
    if process.poll() is None:
        try:
            # Neovim may be showing a startup hit-enter prompt after a terminal
            # capability query. Dismiss it before sending the quit command.
            os.write(master_fd, b"\r")
        except OSError:
            pass
        time.sleep(0.05)
        read_available(master_fd, transcript)
        try:
            os.write(master_fd, b"\x1b:qa!\r")
        except OSError:
            pass
        try:
            wait_for_exit(process, master_fd, transcript, 2.0)
        except Exception:
            terminate_child(process)
            read_available(master_fd, transcript)
    else:
        read_available(master_fd, transcript)
    return terminal_restored(transcript)


def terminate_child(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def read_available(master_fd, transcript):
    while True:
        readable, _, _ = select.select([master_fd], [], [], 0)
        if not readable:
            return
        try:
            chunk = os.read(master_fd, 65536)
        except OSError:
            return
        if not chunk:
            return
        transcript.extend(chunk)
        answer_terminal_queries(master_fd, chunk)


def answer_terminal_queries(master_fd, chunk):
    """Answer common xterm queries while retaining split control sequences."""
    terminal_query_pending.extend(chunk)
    while terminal_query_pending:
        matches = [
            (terminal_query_pending.find(query), query, response)
            for query, response in TERMINAL_QUERY_RESPONSES
            if terminal_query_pending.find(query) >= 0
        ]
        if matches:
            offset, query, response = min(matches, key=lambda match: (match[0], -len(match[1])))
            del terminal_query_pending[: offset + len(query)]
            try:
                os.write(master_fd, response)
            except OSError:
                return
            continue

        retained = 0
        for query, _response in TERMINAL_QUERY_RESPONSES:
            candidate_length = min(len(terminal_query_pending), len(query) - 1)
            while candidate_length > retained:
                if terminal_query_pending[-candidate_length:] == query[:candidate_length]:
                    retained = candidate_length
                    break
                candidate_length -= 1
        if retained:
            del terminal_query_pending[:-retained]
        else:
            terminal_query_pending.clear()


def encode_keys(keys):
    replacements = {
        "<Esc>": b"\x1b",
        "<CR>": b"\r",
        "<Enter>": b"\r",
        "<Tab>": b"\t",
        "<BS>": b"\x7f",
        "<Space>": b" ",
        "<C-C>": b"\x03",
        "<C-F>": b"\x06",
        "<C-B>": b"\x02",
        "<C-E>": b"\x05",
        "<C-Y>": b"\x19",
        "<C-[>": b"\x1b",
        "<C-M>": b"\r",
        "<C-I>": b"\t",
    }
    output = bytearray()
    index = 0
    while index < len(keys):
        if keys[index] == "<":
            end = keys.find(">", index + 1)
            if end >= 0:
                token = keys[index : end + 1]
                replacement = replacements.get(token)
                if replacement is None:
                    raise RuntimeError(f"unsupported-pty-key-token: {token}")
                output.extend(replacement)
                index = end + 1
                continue
        output.extend(keys[index].encode("utf-8"))
        index += 1
    return bytes(output)


def lua_setup():
    return r'''local spec = vim.json.decode(table.concat(vim.fn.readfile(vim.env.XI_ORACLE_SPEC, 'b'), '\n'))
local function copy_lines(lines)
  local result = {}
  for index, line in ipairs(lines) do result[index] = line end
  return result
end
local function install_fixture_clipboard()
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
install_fixture_clipboard()
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
vim.bo.filetype = ''
for name, value in pairs(spec.options or {}) do
  if name ~= 'columns' and name ~= 'lines' then vim.o[name] = value end
end
vim.api.nvim_buf_set_lines(0, 0, -1, true, #spec.lines == 0 and { '' } or spec.lines)
vim.bo.endofline = spec.endOfLine ~= false
vim.bo.fileformat = spec.fileFormat or 'unix'
vim.bo.fileencoding = 'utf-8'
vim.bo.bomb = false
vim.bo.filetype = ''
vim.bo.modified = false
if type(spec.searchPattern) == 'string' then
  vim.fn.setreg('/', spec.searchPattern)
  vim.o.hlsearch = true
  vim.api.nvim_set_hl(0, 'Search', { ctermfg = 0, ctermbg = 11 })
  vim.fn.matchadd('Search', spec.searchPattern)
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
local function capture()
  local position = vim.fn.getpos('.')
  local view = vim.fn.winsaveview()
  local mode = vim.api.nvim_get_mode()
  local screen = vim.fn.screenpos(0, position[2], math.max(position[3], 1))
  return {
    label = 'real-pty',
    lines = vim.api.nvim_buf_get_lines(0, 0, -1, true),
    cursor = {
      line = position[2], byteColumn = position[3], coladd = position[4],
      virtualColumn = vim.fn.virtcol('.'), desiredColumn = view.curswant,
      screenRow = screen.row, screenColumn = screen.col
    },
    mode = mode.mode,
    blocking = mode.blocking,
    geometry = {
      columns = vim.o.columns, lines = vim.o.lines,
      windowWidth = vim.api.nvim_win_get_width(0), windowHeight = vim.api.nvim_win_get_height(0)
    },
    view = view,
    options = { wrap = vim.o.wrap, linebreak = vim.o.linebreak },
    buffer = { endOfLine = vim.bo.endofline, fileFormat = vim.bo.fileformat, filetype = vim.bo.filetype },
    registers = {
      ['"'] = { lines = vim.fn.getreg('"', 1, true), type = vim.fn.getregtype('"') },
      ['+'] = { lines = vim.fn.getreg('+', 1, true), type = vim.fn.getregtype('+') },
      ['*'] = { lines = vim.fn.getreg('*', 1, true), type = vim.fn.getregtype('*') }
    }
  }
end
vim.api.nvim_create_user_command('XiOracleCapture', function()
  vim.schedule(function()
    vim.fn.writefile({ vim.json.encode({ ok = true, fixtureId = spec.id, snapshot = capture() }) }, vim.env.XI_ORACLE_RESULT, 'b')
  end)
end, {})
'''


if __name__ == "__main__":
    raise SystemExit(main())
