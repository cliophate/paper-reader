#!/usr/bin/env python3
"""Exercise a Paper image against disposable Miniflux and PostgreSQL services."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
ENGINE = os.environ.get('PAPER_CONTAINER_ENGINE', 'docker')
IMAGE = os.environ.get('PAPER_TEST_IMAGE', 'paper-public:test')
VERSION = os.environ.get('MINIFLUX_TEST_VERSION', '2.3.2')
assert VERSION in ('2.3.2', '2.3.3'), 'Choose an explicitly tested Miniflux version'
MINIFLUX = 'docker.io/miniflux/miniflux:' + VERSION
POSTGRES = 'docker.io/library/postgres:17.7-bookworm'
NODE = 'docker.io/library/node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9'
PREFIX = 'paper-miniflux-' + uuid.uuid4().hex[:10]
containers = []


def engine(*arguments, check=True):
    args = list(arguments)
    if Path(ENGINE).name == 'podman' and args[0] == 'run':
        if '--user' in args:
            args.insert(1, '--userns=keep-id')
        for index, value in enumerate(args):
            if index and args[index - 1] == '-v':
                args[index] = value + (',z' if value.endswith(':ro') else ':Z')
    result = subprocess.run([ENGINE, *args], capture_output=True, text=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError('Disposable container operation failed: ' + result.stderr.strip())
    return (result.stdout + (result.stderr if args[0] == 'logs' else '')).strip()


def run(name, *args):
    name = PREFIX + '-' + name
    containers.append(name)
    engine('run', '-d', '--name', name, '--network', PREFIX, *args)
    return name


def address(name, port):
    binding = engine('port', name, str(port)).splitlines()[0]
    assert binding.startswith('127.0.0.1:')
    return 'http://' + binding


def request(url, data=None, headers=None, method=None):
    payload = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url, payload, {'Content-Type': 'application/json', **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        return error.code, None


def until(check):
    for _ in range(160):
        try:
            result = check()
            if result:
                return result
        except (OSError, urllib.error.URLError, ValueError, TypeError, KeyError):
            pass
        time.sleep(.25)
    raise RuntimeError('Timed out waiting for disposable Miniflux services')


with tempfile.TemporaryDirectory(prefix='paper-miniflux-installation-') as directory:
    temporary = Path(directory)
    temporary.chmod(0o755)
    engine('network', 'create', PREFIX)
    paper = None
    api_key = ''
    try:
        postgres = run('postgres', '--network-alias', 'postgres', '-e', 'POSTGRES_USER=fixture',
                       '-e', 'POSTGRES_PASSWORD=synthetic-postgres-password', '-e', 'POSTGRES_DB=miniflux', POSTGRES)
        until(lambda: 'accepting connections' in engine('exec', postgres, 'pg_isready', '-U', 'fixture', check=False))
        run('fixture', '--network-alias', 'fixture', '-v', f'{ROOT / "tests/feed-fixture.mjs"}:/fixture.mjs:ro', NODE, 'node', '/fixture.mjs')
        miniflux = run('miniflux', '--network-alias', 'miniflux', '-p', '127.0.0.1::8080',
                       '-e', 'DATABASE_URL=postgres://fixture:synthetic-postgres-password@postgres/miniflux?sslmode=disable',
                       '-e', 'RUN_MIGRATIONS=1', '-e', 'CREATE_ADMIN=1', '-e', 'ADMIN_USERNAME=fixture',
                       '-e', 'ADMIN_PASSWORD=synthetic-miniflux-password', '-e', 'DISABLE_SCHEDULER_SERVICE=1',
                       '-e', 'CLEANUP_ARCHIVE_READ_DAYS=-1', '-e', 'CLEANUP_ARCHIVE_UNREAD_DAYS=-1',
                       '-e', 'FETCHER_ALLOW_PRIVATE_NETWORKS=1', MINIFLUX)
        remote = address(miniflux, 8080)
        basic = {'Authorization': 'Basic ' + base64.b64encode(b'fixture:synthetic-miniflux-password').decode()}
        until(lambda: request(remote + '/v1/me', headers=basic)[0] == 200)
        code, created = request(remote + '/v1/api-keys', {'description': 'Disposable Paper integration'}, basic)
        assert code == 201, 'Could not create a disposable API key'
        api_key = created['token']
        auth = {'X-Auth-Token': api_key}
        assert request(remote + '/v1/version', headers=auth)[1]['version'] == VERSION
        writers = request(remote + '/v1/categories', {'title': 'Writers'}, auth)[1]['id']

        def start(state):
            state.mkdir(exist_ok=True)
            state.chmod(0o700)
            name = run('paper-' + uuid.uuid4().hex[:6], '--user', f'{os.getuid()}:{os.getgid()}',
                       '-p', '127.0.0.1::8080', '-v', f'{state}:/data',
                       '-e', 'PAPER_BACKEND=miniflux', '-e', 'MINIFLUX_BASE_URL=http://miniflux:8080',
                       '-e', 'MINIFLUX_API_KEY=' + api_key, '-e', 'PUBLIC_URL=http://localhost',
                       '-e', 'PAPER_TRUSTED_FEED_ORIGINS=http://fixture:8080', IMAGE)
            base = address(name, 8080)
            def ready():
                status = request(base + '/api/status')[1]
                return status['localReadsActive'] and status['sync']['lastCompletedAt']
            until(ready)
            return name, base

        state = temporary / 'data'
        paper, base = start(state)
        status = request(base + '/api/status')[1]
        assert status['backend'] == 'miniflux' and status['localReadsActive']
        assert not any(status[key] for key in ('readwiseConfigured', 'kirbyConfigured', 'briefingConfigured', 'discussionConfigured'))
        assert status['sync']['entryCount'] == 0
        code, created = request(remote + '/v1/feeds', {'feed_url': 'http://fixture:8080/feed.xml'}, auth)
        assert code == 201, 'Disposable feed creation failed'
        remote_feed_id = created['feed_id']
        assert request(base + '/api/sync', {})[0] == 200
        page = request(base + '/api/entries?kind=all&id=all&unread=0')[1]
        assert len(page['items']) == 2
        entry_id = page['items'][0]['id']
        upstream_id = int(entry_id.split(':')[-1])
        for operation in ('read', 'star', 'star'):
            assert request(base + '/api/entries/state', {'ids': [entry_id], 'operation': operation})[0] == 200
        upstream = request(remote + f'/v1/entries/{upstream_id}', headers=auth)[1]
        assert upstream['status'] == 'read' and upstream['starred']
        assert request(base + '/api/reading', {'id': entry_id, 'position': .42})[0] == 200
        assert request(remote + '/v1/entries', {'entry_ids': [upstream_id], 'status': 'unread', 'starred': False}, auth, 'PUT')[0] == 204
        assert request(remote + f'/v1/entries/{upstream_id}', {'title': 'Updated old synthetic article'}, auth, 'PUT')[0] == 201
        assert request(base + '/api/sync', {})[0] == 200
        changed = request(base + '/api/entries?kind=all&id=all&unread=0')[1]['items']
        assert next(row for row in changed if row['id'] == entry_id)['title'] == 'Updated old synthetic article'
        assert request(base + '/api/sync/parity')[1]['ready']

        organization = request(base + '/api/organization')[1]
        source = next(folder for folder in organization['navigation']['folders'] if folder['feeds'])
        destination = next(folder for folder in organization['navigation']['folders'] if folder['title'] == 'Writers')
        feed_id = source['feeds'][0]['id']
        commands = {'expectedRevision': None, 'commands': [
            {'type': 'move-feed', 'feedId': feed_id, 'fromFolderId': source['id'], 'toFolderId': destination['id']},
            {'type': 'rename-feed', 'feedId': feed_id, 'title': 'Renamed synthetic feed'}]}
        assert all(row['status'] == 'applied' for row in request(base + '/api/organization/commands', commands)[1]['results'])
        assert request(remote + f'/v1/feeds/{remote_feed_id}', headers=auth)[1]['category']['id'] == writers
        request(remote + f'/v1/categories/{writers}', {'title': 'Renamed Writers'}, auth, 'PUT')
        updated = request(base + '/api/organization?refresh=1')[1]['navigation']['folders']
        assert next(folder for folder in updated if folder['id'] == destination['id'])['title'] == 'Renamed Writers'

        xml = request(base + '/api/subscription-tools/export')[1]['xml']
        assert api_key not in xml
        preview = request(base + '/api/subscription-tools/preview-feed', {'url': 'http://fixture:8080/backdated.xml', 'title': 'Backdated feed'})[1]
        applied = request(base + '/api/subscription-tools/apply', {'token': preview['token'], 'choices': [{'key': preview['rows'][0]['key'], 'action': 'create', 'folders': []}]})[1]
        assert applied['results'][0]['status'] == 'created'
        assert request(base + '/api/sync', {})[0] == 200
        assert request(base + '/api/status')[1]['sync']['entryCount'] == 92

        settings = request(base + '/api/settings/connections')[1]
        assert api_key not in json.dumps(settings)
        engine('stop', paper)
        restored = temporary / 'restored'
        shutil.copytree(state, restored)
        paper, base = start(restored)
        restored_rows = request(base + '/api/entries?kind=all&id=all&unread=0')[1]['items']
        assert next(row for row in restored_rows if row['id'] == entry_id)['readingPosition'] == .42
        assert (restored / 'secrets.json').stat().st_mode & 0o777 == 0o600
        print(f'Miniflux {VERSION} installation passed: native API, two-way state, old content, backdated imports, categories, OPML and restore.')
    except Exception:
        if paper:
            print(engine('logs', '--tail', '30', paper, check=False).replace(api_key, '[redacted]') if api_key else 'Paper startup failed')
        raise
    finally:
        for name in reversed(containers):
            engine('rm', '-f', '-v', name, check=False)
        engine('network', 'rm', PREFIX, check=False)
