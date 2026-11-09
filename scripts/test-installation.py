#!/usr/bin/env python3
"""Test a release image with disposable FreshRSS, feed, and proxy containers."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
FRESHRSS = 'freshrss/freshrss:1.30.4@sha256:af44385229541bee24aa9148d0ff8f3b40e095373c63a2c0f74e09a27d3c59df'
NODE = 'node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9'
CADDY = 'caddy:2.11.9@sha256:0c2243efcf437ab7f7a978f1027fcf0d4f9be8a75df27b1b3fbc5dbe0ffa8cf0'
IMAGE = os.environ.get('PAPER_TEST_IMAGE', 'paper-public:0.1.0-alpha.1')
PREFIX = 'paper-release-' + uuid.uuid4().hex[:10]
containers = []


def docker(*args, check=True):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=60)
    if check and result.returncode:
        raise RuntimeError('Docker test operation failed: ' + result.stderr.strip())
    return result.stdout.strip()


def run(name, *args):
    full = PREFIX + '-' + name
    containers.append(full)
    docker('run', '-d', '--name', full, '--network', PREFIX, '--network-alias', name, *args)
    return full


def address(name, port):
    binding = docker('port', name, str(port)).splitlines()[0]
    assert binding.startswith('127.0.0.1:')
    return 'http://' + binding


def request(url, data=None, headers=None):
    payload = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url, payload, {'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            body = res.read()
            return res.status, json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        return error.code, None


def form(url, values, headers=None):
    req = urllib.request.Request(url, urllib.parse.urlencode(values, doseq=True).encode(), headers or {})
    with urllib.request.urlopen(req, timeout=10) as res:
        return res.read().decode()


def until(check):
    for _ in range(80):
        try:
            value = check()
            if value:
                return value
        except (OSError, urllib.error.URLError, json.JSONDecodeError, AttributeError, TypeError):
            pass
        time.sleep(0.25)
    raise RuntimeError('Timed out waiting for isolated release services')


def start_paper(state):
    state.mkdir(exist_ok=True)
    state.chmod(0o777)
    return run('paper', '-p', '127.0.0.1::8080', '-v', f'{state}:/data',
               '-e', 'HOST=0.0.0.0', '-e', 'PUBLIC_URL=http://localhost',
               '-e', 'FRESHRSS_BASE_URL=http://freshrss', '-e', 'FRESHRSS_USERNAME=fixture',
               '-e', 'FRESHRSS_API_PASSWORD=synthetic-api-password',
               '-e', 'PAPER_INTERNAL_SECRET=synthetic-internal-secret-for-release-test',
               '-e', 'PAPER_SIGNING_SECRET=synthetic-signing-secret-for-release-test',
               '-e', 'PAPER_TRUSTED_FEED_ORIGINS=http://fixture:8080',
               '-e', 'CODEX_ENABLED=false', '-e', 'OPENCODE_ENABLED=false', IMAGE)


with tempfile.TemporaryDirectory(prefix='paper-installation-') as directory:
    temporary = Path(directory)
    temporary.chmod(0o755)
    docker('network', 'create', PREFIX)
    try:
        run('fixture', '-v', f'{ROOT / "tests/feed-fixture.mjs"}:/fixture.mjs:ro', NODE, 'node', '/fixture.mjs')
        fresh = run('freshrss', '-p', '127.0.0.1::80', '--tmpfs', '/var/www/FreshRSS/data:rw,mode=1777',
                    '-e', 'TZ=UTC', '-e', 'INTERNAL_HOST_ALLOWLIST=fixture:8080',
                    '-e', 'FRESHRSS_INSTALL=--default-user=fixture --db-type=sqlite --api-enabled --base-url=http://freshrss',
                    '-e', 'FRESHRSS_USER=--user=fixture --password=synthetic-login-password --api-password=synthetic-api-password --no-default-feeds',
                    '-v', f'{ROOT / "integrations/paper-feed-health.php"}:/var/www/FreshRSS/p/api/paper-feed-health.php:ro',
                    '-v', f'{ROOT / "integrations/paper-feed-repair.php"}:/var/www/FreshRSS/p/api/paper-feed-repair.php:ro', FRESHRSS)
        upstream = address(fresh, 80)
        login = until(lambda: form(upstream + '/api/greader.php/accounts/ClientLogin', {'Email': 'fixture', 'Passwd': 'synthetic-api-password'}))
        token = next(line[5:] for line in login.splitlines() if line.startswith('Auth='))
        auth = {'Authorization': 'GoogleLogin auth=' + token}
        result = json.loads(form(upstream + '/api/greader.php/reader/api/0/subscription/quickadd', {'quickadd': 'http://fixture:8080/feed.xml'}, auth))
        assert result.get('numResults') == 1, result
        assert request(upstream + '/api/paper-feed-health.php', headers=auth)[0] == 200
        paper = start_paper(temporary / 'data')
        base = address(paper, 8080)
        until(lambda: request(base + '/api/status')[1].get('localReadsActive'))
        assert request(base + '/api/sync/parity')[1]['ready']
        page = request(base + '/api/entries?kind=all&id=all&unread=0&q=compositor')[1]
        assert len(page['items']) == 2
        entry = page['items'][0]
        for operation in ['read', 'star']:
            assert request(base + '/api/entries/state', {'ids': [entry['id']], 'operation': operation})[0] == 200
        assert request(base + '/api/reading', {'id': entry['id'], 'position': 0.42})[0] == 200
        edit_token = urllib.request.urlopen(urllib.request.Request(upstream + '/api/greader.php/reader/api/0/token', headers=auth)).read().decode()
        form(upstream + '/api/greader.php/reader/api/0/edit-tag', {'i': entry['id'], 'r': 'user/-/state/com.google/read', 'T': edit_token}, auth)
        assert request(base + '/api/sync', {})[0] == 200
        assert not request(base + '/api/entries/item', {'id': entry['id']})[1]['entry']['read']
        assert request(base + '/api/feeds/repair', {'id': entry['feedId'], 'url': 'http://fixture:8080/repaired.xml', 'expectedUrl': 'http://fixture:8080/feed.xml'})[0] == 200
        hash_value = docker('run', '--rm', '--network', 'none', CADDY, 'caddy', 'hash-password', '--plaintext', 'synthetic-proxy-password')
        config = temporary / 'Caddyfile'
        config.write_text((ROOT / 'examples/Caddyfile').read_text())
        proxy = run('proxy', '-p', '127.0.0.1::80', '-v', f'{config}:/etc/caddy/Caddyfile:ro',
                    '-e', 'PAPER_DOMAIN=http://localhost', '-e', 'PAPER_AUTH_USER=fixture',
                    '-e', 'PAPER_AUTH_PASSWORD_HASH=' + hash_value, CADDY)
        protected = address(proxy, 80)
        until(lambda: request(protected + '/health', headers={'Host': 'localhost'})[0] == 401)
        assert request(protected + '/api/navigation', headers={'Host': 'localhost'})[0] == 401
        credentials = base64.b64encode(b'fixture:synthetic-proxy-password').decode()
        assert request(protected + '/api/navigation', headers={'Host': 'localhost', 'Authorization': 'Basic ' + credentials})[0] == 200
        docker('exec', proxy, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile')
        for helper in ['paper-feed-health.php', 'paper-feed-repair.php']:
            docker('exec', fresh, 'php', '-l', '/var/www/FreshRSS/p/api/' + helper)
        docker('stop', paper)
        restored = temporary / 'restored'
        shutil.copytree(temporary / 'data', restored)
        docker('rm', '-f', paper, check=False)
        paper = start_paper(restored)
        base = address(paper, 8080)
        until(lambda: request(base + '/health')[0] == 200)
        saved = request(base + '/api/entries/item', {'id': entry['id']})[1]['entry']
        assert saved['starred'] and not saved['read'] and saved['readingPosition'] == 0.42
        print('Installation checks passed with FreshRSS 1.30.4: import/search, two-way state sync, helper authentication/repair, proxy 401/200, PHP syntax, and backup restoration.')
    except Exception:
        for name in dict.fromkeys(containers):
            logs = docker('logs', '--tail', '12', name, check=False)
            print(name, logs[-2000:])
        raise
    finally:
        for name in reversed(list(dict.fromkeys(containers))):
            docker('rm', '-f', name, check=False)
        docker('network', 'rm', PREFIX, check=False)
