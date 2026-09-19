#!/usr/bin/env python3
"""Assert the deployment invariants CI verified with inline jq blocks.

CI checked these with four un-copy-pastable jq pipelines, so no contributor
could reproduce them before pushing. This keeps the environment-independent
boundaries — privilege drops, port exposure, network isolation, required
variables — as a local gate that also runs where Docker is absent.

The dev entry point is deliberately excluded from production hardening; its
invariant is that the backend stays on loopback.
"""
import os
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
# ${VAR}, ${VAR:-default} and ${VAR:?message}, which compose treats as required.
SUBSTITUTION = re.compile(r'\$\{(\w+)(?::([-?])(.*?))?\}')
PRODUCTION = ('docker-compose.yml', 'docker-compose.traefik.yml')
ENTRY_POINTS = PRODUCTION + ('docker-compose.dev.yml',)
NAMED_VOLUMES = 'docker-compose.named-volume.yml'


def resolve(value, missing):
    if isinstance(value, dict):
        return {key: resolve(item, missing) for key, item in value.items()}
    if isinstance(value, list):
        return [resolve(item, missing) for item in value]
    if not isinstance(value, str):
        return value

    def substitute(match):
        name, operator, fallback = match.group(1), match.group(2), match.group(3)
        if name in os.environ:
            return os.environ[name]
        if operator == ':':
            missing.add(name)
            return ''
        return fallback or ''

    return SUBSTITUTION.sub(substitute, value)


def load(name, missing):
    with open(ROOT / name) as handle:
        return resolve(yaml.safe_load(handle), missing)


def mapping(value):
    """Compose allows environment and labels as a map or a KEY=VALUE list."""
    if not value:
        return {}
    if isinstance(value, dict):
        return {str(key): str(item) for key, item in value.items()}
    return dict(str(item).split('=', 1) for item in value)


def ports_of(document, service):
    return document['services'][service].get('ports') or []


def main():
    os.environ.setdefault('TRAEFIK_HOST', 'fangji.example.com')
    missing = set()
    problems = []

    def check(condition, message):
        if not condition:
            problems.append(message)

    documents = {name: load(name, missing) for name in ENTRY_POINTS + (NAMED_VOLUMES,)}
    production = documents['docker-compose.yml']
    development = documents['docker-compose.dev.yml']
    edge = documents['docker-compose.traefik.yml']

    for name in PRODUCTION:
        for service, settings in documents[name]['services'].items():
            check(settings.get('cap_drop') == ['ALL'], f'{name}: {service} does not drop all capabilities')
            check('no-new-privileges:true' in (settings.get('security_opt') or []),
                  f'{name}: {service} can gain privileges')
            check('healthcheck' in settings, f'{name}: {service} has no health check')
        check(documents[name]['services']['backend'].get('read_only') is True,
              f'{name}: the backend filesystem is writable')
        check('ports' not in documents[name]['services']['backend'], f'{name}: the backend publishes a port')

    check(mapping(production['services']['frontend'].get('labels')) == {},
          'docker-compose.yml: the plain entry point carries proxy labels')
    check(ports_of(production, 'frontend') == ['8080:8080'],
          f'docker-compose.yml frontend must publish exactly 8080, got {ports_of(production, "frontend")}')
    check(mapping(production['services']['frontend'].get('environment'))['ENABLE_POCKETBASE_ADMIN_UI'] == 'false',
          'docker-compose.yml: the admin UI must be off by default')

    check(ports_of(development, 'backend') == ['127.0.0.1:8090:8090'],
          f'docker-compose.dev.yml backend must stay on loopback, got {ports_of(development, "backend")}')
    check(ports_of(development, 'frontend') == ['5250:5250'],
          f'docker-compose.dev.yml frontend must publish 5250, got {ports_of(development, "frontend")}')

    check('ports' not in edge['services']['frontend'], 'docker-compose.traefik.yml publishes a frontend port')
    check(edge['networks']['traefik'].get('external') is True
          and edge['networks']['traefik'].get('name') == 'traefik-global-proxy',
          'docker-compose.traefik.yml must reuse the external traefik-global-proxy network')
    check(set(edge['services']['backend'].get('networks', {})) == {'app'},
          'docker-compose.traefik.yml leaks the backend onto the edge network')
    check('traefik' in edge['services']['frontend'].get('networks', {}),
          'docker-compose.traefik.yml frontend is unreachable from the proxy')
    labels = mapping(edge['services']['frontend'].get('labels'))
    check(labels.get('traefik.docker.network') == 'traefik-global-proxy',
          'docker-compose.traefik.yml: the proxy must target the external network')
    check(labels.get('traefik.http.routers.fangji.rule') == f"Host(`{os.environ['TRAEFIK_HOST']}`)",
          f"docker-compose.traefik.yml router rule is {labels.get('traefik.http.routers.fangji.rule')!r}")
    check(labels.get('traefik.http.services.fangji.loadbalancer.server.port') == '8080',
          'docker-compose.traefik.yml targets the wrong container port')
    check('fangji-security' in (labels.get('traefik.http.routers.fangji.middlewares') or ''),
          'docker-compose.traefik.yml router has no security middleware')
    check(mapping(edge['services']['frontend'].get('environment'))['ENABLE_POCKETBASE_ADMIN_UI'] == 'true',
          'docker-compose.traefik.yml must keep the admin UI reachable through the proxy route')

    for name in ENTRY_POINTS:
        merged = {**documents[name]['services']['backend'], **documents[NAMED_VOLUMES]['services']['backend']}
        check(merged.get('volumes'), f'{name} + {NAMED_VOLUMES} has no backend data volume')
        build = documents[name]['services']['backend'].get('build') or {}
        check('COMMIT' in (build.get('args') or {}), f'{name}: the backend build passes no COMMIT stamp')

    if missing:
        problems.append('required compose variables are unset: ' + ', '.join(sorted(missing)))

    if problems:
        print('compose invariants violated:', file=sys.stderr)
        for problem in problems:
            print(f'  - {problem}', file=sys.stderr)
        return 1
    print('PASS: compose entry points keep privilege, port, network and stamp boundaries')
    return 0


if __name__ == '__main__':
    sys.exit(main())
