#!/usr/bin/env python3
"""Inspect Xi's canonical planning backlog. This does not certify product tests."""
import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'docs/plan/tickets.json'
STATUSES = {'todo', 'in_progress', 'blocked', 'done'}

def validate(data, root=ROOT):
    errors = []
    if not isinstance(data, dict) or data.get('schema_version') != 1:
        return ['Expected schema_version 1 object']
    tickets = data.get('tickets')
    if not isinstance(tickets, list) or not tickets:
        return ['Expected a nonempty tickets list']
    by_id = {}
    for ticket in tickets:
        if not isinstance(ticket, dict):
            errors.append('Ticket must be an object')
            continue
        tid = ticket.get('id')
        if not isinstance(tid, str) or not re.fullmatch(r'T\d{3}(?:-[a-z0-9]+)?', tid):
            errors.append(f'Invalid ticket ID: {tid!r}')
            continue
        if tid in by_id:
            errors.append(f'Duplicate ticket: {tid}')
        by_id[tid] = ticket
        for field in ('title', 'owner'):
            if not isinstance(ticket.get(field), str) or not ticket[field].strip():
                errors.append(f'{tid}: missing {field}')
        if ticket.get('status') not in STATUSES:
            errors.append(f'{tid}: invalid status')
        for field in ('paths', 'specs', 'steps', 'acceptance', 'failure_cases', 'evidence', 'depends_on'):
            values = ticket.get(field)
            if not isinstance(values, list) or any(not isinstance(v, str) or not v.strip() for v in values):
                errors.append(f'{tid}: invalid {field}')
            elif field != 'depends_on' and not values:
                errors.append(f'{tid}: empty {field}')
        for spec in ticket.get('specs', []) if isinstance(ticket.get('specs'), list) else []:
            if isinstance(spec, str) and not (root / spec).is_file():
                errors.append(f'{tid}: missing specification {spec}')
        if ticket.get('status') == 'blocked' and not ticket.get('blocker'):
            errors.append(f'{tid}: blocked needs a concrete blocker')
        if ticket.get('status') == 'done':
            report = ticket.get('report')
            if not isinstance(report, str) or not (root / report).is_file():
                errors.append(f'{tid}: done needs an existing evidence report')
    if errors:
        return errors
    for tid, ticket in by_id.items():
        deps = ticket['depends_on']
        if len(set(deps)) != len(deps):
            errors.append(f'{tid}: duplicate dependency')
        for dep in deps:
            if dep not in by_id:
                errors.append(f'{tid}: unknown dependency {dep}')
            elif ticket['status'] in {'done', 'in_progress'} and by_id[dep]['status'] != 'done':
                errors.append(f'{tid}: dependency {dep} is not done')
    visiting, visited = set(), set()
    def visit(tid, chain):
        if tid in visiting:
            errors.append('Dependency cycle: ' + ' -> '.join(chain + [tid]))
            return
        if tid in visited or tid not in by_id:
            return
        visiting.add(tid)
        for dep in by_id[tid]['depends_on']:
            visit(dep, chain + [tid])
        visiting.remove(tid)
        visited.add(tid)
    for tid in by_id:
        visit(tid, [])
    return errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'next', 'show', 'list'])
    parser.add_argument('ticket', nargs='?')
    args = parser.parse_args()
    try:
        data = json.loads(PLAN.read_text())
        errors = validate(data)
    except (OSError, ValueError) as exc:
        print(f'Cannot load plan: {exc}', file=sys.stderr)
        return 1
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    tickets = data['tickets']
    by_id = {ticket['id']: ticket for ticket in tickets}
    if args.command == 'check':
        print(f'Plan valid: {len(tickets)} tickets; dependency graph and report references checked.')
        print('This does not verify product acceptance or evidence truth.')
    elif args.command == 'show':
        if args.ticket not in by_id:
            parser.error('show requires an existing ticket ID')
        ticket = by_id[args.ticket]
        print(f"{ticket['id']}: {ticket['title']} [{ticket['status']}]")
        print(f"Owner: {ticket['owner']}; dependencies: {', '.join(ticket['depends_on']) or 'none'}")
        for field in ['paths', 'specs', 'steps', 'acceptance', 'failure_cases', 'evidence']:
            print('\n' + field.replace('_', ' ').capitalize() + ':')
            for item in ticket[field]:
                print('  - ' + item)
    else:
        chosen = tickets if args.command == 'list' else [t for t in tickets if t['status'] == 'todo' and all(by_id[d]['status'] == 'done' for d in t['depends_on'])]
        for ticket in chosen:
            print(f"{ticket['id']} [{ticket['status']}] {ticket['title']}")
        if not chosen:
            print('No ready tickets. Inspect in_progress/blocked tickets and their prerequisites.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
