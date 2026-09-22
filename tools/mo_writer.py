#!/usr/bin/env python3
"""Compile a .po (UTF-8) into a GNU .mo (little-endian). Pure python, no
gettext binaries involved (they served stale results in this environment)."""
import ast
import struct
import sys


def parse_po(path):
    entries = []  # list of (msgid, msgstr)
    cur = None
    in_obsolete = False

    def flush():
        nonlocal cur
        if cur is not None:
            entries.append((''.join(cur['id']), ''.join(cur['str'])))
        cur = None

    with open(path, 'rb') as f:
        text = f.read().decode('utf-8')

    for raw in text.split('\n'):
        line = raw.strip()
        if line.startswith('#~'):
            flush()
            cur = None
            in_obsolete = True
            continue
        if line == '' or line.startswith('#'):
            continue
        in_obsolete = False
        if line.startswith('msgid'):
            flush()
            cur = {'id': [], 'str': []}
            rest = line[5:].strip()
            if rest:
                cur['id'].append(ast.literal_eval(rest))
            continue
        if line.startswith('msgstr'):
            if cur is None:
                cur = {'id': [], 'str': []}
            rest = line[6:].strip()
            if rest:
                cur['str'].append(ast.literal_eval(rest))
            continue
        if line.startswith('"') and cur is not None and not in_obsolete:
            if cur['str']:
                cur['str'].append(ast.literal_eval(line))
            else:
                cur['id'].append(ast.literal_eval(line))
    flush()
    return entries


def write_mo(entries, out_path):
    # sort by msgid bytes; empty msgid (header) sorts first
    entries = sorted(entries, key=lambda e: e[0].encode('utf-8'))
    # encode as UTF-8
    entries = [(mid.encode('utf-8'), mstr.encode('utf-8')) for mid, mstr in entries]
    n = len(entries)
    # header: magic, revision, N, O, T, S, H  (7 x uint32 = 28 bytes)
    orig_table_off = 28
    trans_table_off = 28 + 8 * n
    data_off = trans_table_off + 8 * n

    o_table = b''
    t_table = b''
    off = data_off
    for mid, mstr in entries:
        o_table += struct.pack('<II', len(mid), off)
        off += len(mid) + 1
    for mid, mstr in entries:
        t_table += struct.pack('<II', len(mstr), off)
        off += len(mstr) + 1

    data = b''
    for mid, mstr in entries:
        data += mid + b'\0'
    for mid, mstr in entries:
        data += mstr + b'\0'

    header = struct.pack('<7I', 0x950412de, 0, n, orig_table_off, trans_table_off, 0, 0)
    with open(out_path, 'wb') as f:
        f.write(header + o_table + t_table + data)


if __name__ == '__main__':
    po_path, mo_path = sys.argv[1], sys.argv[2]
    entries = parse_po(po_path)
    headers = [e for e in entries if e[0] == '']
    rest = [e for e in entries if e[0] != '']
    print('parsed entries:', len(entries), 'headers:', len(headers))
    write_mo(headers + rest, mo_path)
    print('wrote', mo_path)