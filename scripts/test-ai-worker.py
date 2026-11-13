#!/usr/bin/env python3
"""Exercise the AI compose with disposable data and fake or real Codex."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
REAL = '--real' in sys.argv
IMAGE = os.environ.get('PAPER_TEST_IMAGE', 'paper-public:test')
AI_IMAGE = os.environ.get('PAPER_TEST_AI_IMAGE', 'paper-public:ai-test')
SECRET = 'synthetic-worker-secret-for-isolation-regression'
SENTINEL = 'synthetic-paper-environment-secret-57'
PROJECT = 'paper-ai-test-' + uuid.uuid4().hex[:10]


def docker(*args, check=True):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=90)
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def request(url, body=None, headers=None, method=None):
    req = urllib.request.Request(url, None if body is None else json.dumps(body).encode(),
                                 {'Content-Type': 'application/json', **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def until(check):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, KeyError, TypeError):
            pass
        time.sleep(0.2)
    raise AssertionError('Timed out waiting for the disposable AI stack')


with tempfile.TemporaryDirectory(prefix='paper-ai-isolation-') as directory:
    root = Path(directory)
    root.chmod(0o755)
    for name in ['compose.yaml', 'compose.ai.yaml', 'compose.proxy.yaml']:
        shutil.copyfile(ROOT / name, root / name)
    shutil.copytree(ROOT / 'recap', root / 'recap')
    profile = root / 'recap/editorial-profile.md'
    profile.write_text(profile.read_text() + '\nSynthetic private editorial profile marker.\n')
    shutil.copytree(ROOT / 'tests/fixtures', root / 'fixtures')
    (root / 'data').mkdir(mode=0o777)
    (root / 'data').chmod(0o777)
    (root / 'ai-auth/codex').mkdir(parents=True, mode=0o777)
    (root / 'ai-auth/codex').chmod(0o777)
    env = root / '.env'
    env.write_text(f'PAPER_BACKEND=standalone\nPUBLIC_URL=http://localhost\nPAPER_AI_WORKER_SECRET={SECRET}\n'
                   'PAPER_UID=1000\nPAPER_GID=1000\nCODEX_ENABLED=true\nPAPER_CLEAR_HEADLINES=false\n'
                   f'PAPER_INTERNAL_SECRET={SENTINEL}\nREADWISE_TOKEN={SENTINEL}\n'
                   'PAPER_TRUSTED_FEED_ORIGINS=http://fixture:8090\n'
                   'PAPER_DOMAIN=http://localhost\nPAPER_AUTH_USER=fixture\nPAPER_AUTH_PASSWORD_HASH=synthetic-config-only-hash\n')
    env.chmod(0o600)
    # Override only fixture transport, images and host port. Keep production hardening.
    override = {
        'services': {
            'paper': {'image': IMAGE, 'ports': ['127.0.0.1::8080']},
            'paper-ai': {'image': AI_IMAGE, 'environment': {'CODEX_BIN': '/fixtures/codex-fixture.sh' if REAL else '/fixtures/ai-installation-cli.mjs'},
                         'volumes': ['./fixtures:/fixtures:ro']},
            'fixture': {'image': IMAGE, 'command': ['node', '/fixtures/ai-provider.mjs'],
                        'volumes': ['./fixtures:/fixtures:ro'], 'networks': ['default', 'ai'], 'ports': ['127.0.0.1::8090']},
        },
    }
    # Compose port merging needs !override to avoid reserving the user's normal port.
    (root / 'compose.test.yaml').write_text('services:\n  paper:\n    ports: !override ["127.0.0.1::8080"]\n')
    (root / 'compose.fixture.json').write_text(json.dumps(override))
    files = ['-f', str(root / 'compose.yaml'), '-f', str(root / 'compose.ai.yaml'), '-f', str(root / 'compose.fixture.json'), '-f', str(root / 'compose.test.yaml')]
    def compose(*args, check=True):
        return docker('compose', '--project-name', PROJECT, '--project-directory', directory, '--env-file', str(env), *files, *args, check=check)
    try:
        proxy_config = json.loads(compose('-f', str(root / 'compose.proxy.yaml'), 'config', '--format', 'json'))
        assert not proxy_config['services']['paper'].get('ports')
        assert set(proxy_config['services']['paper']['networks']) == {'default'}
        assert 'default' in proxy_config['services']['proxy']['networks']
        assert set(proxy_config['services']['paper-ai']['networks']) == {'ai'}
        assert not proxy_config['networks']['ai'].get('internal', False)
        assert proxy_config['services']['paper']['healthcheck']['test']
        compose('up', '-d', '--no-build', '--pull', 'never', 'paper', 'paper-ai', 'fixture')
        paper = compose('ps', '-q', 'paper')
        worker = compose('ps', '-q', 'paper-ai')
        base = 'http://' + compose('port', 'paper', '8080')
        fixture = 'http://' + compose('port', 'fixture', '8090')
        until(lambda: request(base + '/health')[0] == 200)
        settings = until(lambda: value if (value := request(base + '/api/settings/connections')[1])['aiRuntime']['available'] else None)
        assert SECRET not in json.dumps(settings) and SENTINEL not in json.dumps(settings)
        inspect = json.loads(docker('inspect', worker))[0]
        assert not any(mount['Destination'] == '/data' for mount in inspect['Mounts'])
        assert inspect['HostConfig']['ReadonlyRootfs'] and inspect['HostConfig']['CapDrop'] == ['ALL']
        assert inspect['Config']['User'] == '1000:1000'
        assert not inspect['HostConfig']['PortBindings']
        paper_inspect = json.loads(docker('inspect', paper))[0]
        assert set(inspect['NetworkSettings']['Networks']).isdisjoint(paper_inspect['NetworkSettings']['Networks']), 'Paper and worker share a network'
        socket_permissions = docker('exec', worker, 'node', '-e', "const fs=require('node:fs');console.log(JSON.stringify(['/run/paper-ai','/run/paper-ai/worker.sock'].map(p=>{const s=fs.statSync(p);return [s.uid,s.gid,s.mode&511]})))")
        assert json.loads(socket_permissions) == [[1000, 1000, 0o700], [1000, 1000, 0o600]], socket_permissions
        assert not any('/.codex' in mount['Destination'] for mount in paper_inspect['Mounts'])
        assert docker('exec', paper, 'node', '-e', "console.log(require('node:fs').existsSync('/usr/local/bin/codex'))") == 'false'
        worker_env = inspect['Config']['Env']
        assert not any(SENTINEL in value for value in worker_env)
        assert 'no-new-privileges:true' in inspect['HostConfig']['SecurityOpt']
        probe = """const fs=require('node:fs'); if(fs.existsSync('/data'))throw Error('/data is visible');
for(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){let value;try{value=fs.readFileSync('/proc/'+pid+'/environ','utf8')}catch{continue}if(value.includes(process.argv[1]))throw Error('Paper secret is visible')};console.log('isolated')"""
        assert docker('exec', worker, 'node', '-e', probe, SENTINEL) == 'isolated'
        # Probe the disposable Paper service from the worker, including routes that bypass DNS.
        targets = [{'host': 'paper', 'port': 8080}]
        for network in paper_inspect['NetworkSettings']['Networks'].values():
            for key in ['IPAddress', 'GlobalIPv6Address']:
                if network.get(key):
                    targets.append({'host': network[key], 'port': 8080})
        host_port = int(compose('port', 'paper', '8080').rsplit(':', 1)[1])
        gateways = {n.get('Gateway') for n in inspect['NetworkSettings']['Networks'].values()}
        gateways.update(n.get('Gateway') for n in paper_inspect['NetworkSettings']['Networks'].values())
        gateways.update(n.get('Gateway') for n in json.loads(docker('network', 'inspect', 'bridge'))[0]['IPAM']['Config'])
        targets.extend({'host': gateway, 'port': host_port} for gateway in gateways if gateway)
        network_probe = """const net=require('node:net');
const targets=JSON.parse(process.argv[1]);Promise.all(targets.map(target=>new Promise((resolve,reject)=>{
const s=net.connect(target);s.setTimeout(1500);s.once('connect',()=>{s.destroy();reject(Error('Worker reached Paper: '+JSON.stringify(target)))});
s.once('error',()=>resolve());s.once('timeout',()=>{s.destroy();resolve()});
}))).then(()=>console.log('blocked '+targets.length+' Paper addresses')).catch(e=>{console.error(e.message);process.exit(1)})"""
        print(docker('exec', worker, 'node', '-e', network_probe, json.dumps(targets)))
        # SIGKILL leaves the socket behind while Paper retains the tmpfs mount.
        compose('kill', '-s', 'SIGKILL', 'paper-ai')
        compose('up', '-d', '--no-build', '--pull', 'never', 'paper-ai')
        until(lambda: request(base + '/api/settings/connections')[1]['aiRuntime']['available'])
        healthcheck = inspect['Config']['Healthcheck']['Test'][1:]
        docker('exec', worker, *healthcheck)
        # The fixture is the only model provider. No login or account is mounted.
        if REAL:
            versions = docker('exec', worker, 'codex', '--version')
            print('Real CLI:', versions)
            for runner in ['codex', 'discussion']:
                outputs = []
                for state, exists in [('present', True), ('absent', False)]:
                    name = f'probe-{runner}-{state}'
                    target = root / 'data/isolation-secret.txt'
                    if exists:
                        target.write_text('synthetic-paper-private-line\n')
                        target.chmod(0o644)
                    else:
                        target.unlink()  # This test created this exact file above.
                    call = """import http from 'node:http';const runner=process.argv[2];const payload={model:'gpt-5.6-sol',instruction:'Probe the path.',input:{prompt:'Isolation probe '+process.argv[1]+'.'},schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}};const r=http.request({socketPath:process.env.PAPER_AI_WORKER_SOCKET,path:'/v1/'+runner,method:'POST',headers:{'Content-Type':'application/json','x-paper-ai-secret':process.env.PAPER_AI_WORKER_SECRET}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>console.log(JSON.stringify({status:response.statusCode,body}))) });r.on('error',()=>process.exit(1));r.end(JSON.stringify(payload))"""
                    result = json.loads(docker('exec', paper, 'node', '--input-type=module', '-e', call, name, runner))
                    assert result['status'] == 200, result
                    if runner == 'codex':
                        assert json.loads(result['body']) == {'result': {'ok': True}}, result
                    else:
                        events = [json.loads(line) for line in result['body'].splitlines()]
                        assert events[-1] == {'type': 'done'}, events
                        assert ''.join(event.get('text', '') for event in events) == 'Fixture discussion reply.', events
                    records = request(fixture + '/records')[1]
                    calls = [item for record in records if ('Isolation probe ' + name) in json.dumps(record.get('input', [])) for item in record.get('input', []) if item['type'] in ['custom_tool_call_output', 'function_call_output']]
                    assert calls, f'No real apply_patch result for {name}'
                    outputs.append(calls[-1]['output'])
                assert outputs[0] == outputs[1], outputs
                assert 'No such file or directory' in outputs[0], outputs
                print(f'Real {runner} apply_patch returned identical missing-file results with the Paper file present and absent.')
        status, preview = request(base + '/api/subscription-tools/preview-feed', {'url': 'http://fixture:8090/feed.xml', 'title': 'Isolation feed'})
        assert status == 200, preview
        status, created = request(base + '/api/subscription-tools/apply', {'token': preview['token'], 'choices': [{'key': preview['rows'][0]['key'], 'action': 'create', 'folders': []}]})
        assert status == 200, created
        entries = until(lambda: request(base + '/api/entries?kind=all&id=all&unread=0')[1]['items'])
        assert len(entries) == 3
        entry_id = entries[0]['id']
        assert request(base + '/api/discussion', {'entryId': entry_id})[0] == 200
        assert request(base + '/api/discussion/message', {'entryId': entry_id, 'requestId': str(uuid.uuid4()), 'question': 'What does it say?'})[0] == 200
        discussion = until(lambda: value if 'Fixture discussion reply.' in json.dumps(value := request(base + '/api/discussion?entryId=' + entry_id)[1]) else None)
        assert 'Fixture discussion reply.' in json.dumps(discussion)
        status, briefing = request(base + '/api/internal/briefings/generate', {'kind': 'morning', 'force': True}, {'x-paper-secret': SENTINEL})
        assert status == 200, briefing
        assert 'Fixture briefing from the isolated worker.' in json.dumps(briefing), briefing
        if REAL:
            def collection_records():
                records = request(fixture + '/records')[1]
                return records if any('groups' in r.get('text', {}).get('format', {}).get('schema', {}).get('properties', {}) for r in records) else None
            records = until(collection_records)
            schemas = [r.get('text', {}).get('format', {}).get('schema', {}).get('properties', {}) for r in records]
            assert any('writerIds' in schema for schema in schemas) and any('intro' in schema for schema in schemas)
            assert any('Synthetic private editorial profile marker.' in json.dumps(r['input']) for r in records)
        else:
            until(lambda: 'groups' in (root / 'ai-auth/codex/fixture-runs').read_text())
        pulse = until(lambda: value if (value := request(base + '/api/pulse')[1])['status']['lastCompletedAt'] and not value['status']['running'] else None)
        assert not pulse['status']['failed'], pulse
        compose('stop', 'paper-ai')
        unavailable = request(base + '/api/settings/connections')[1]['aiRuntime']
        assert not unavailable['available'] and 'AI is unavailable' in unavailable['message'], unavailable
        assert request(base + '/health')[0] == 200
        print('AI compose checks passed: authenticated socket, permissions, stale-socket restart, network isolation, mounts and hardening, briefing, collection, discussion, and missing-worker Settings message.')
    except Exception:
        print(compose('logs', '--tail', '20', check=False))
        if REAL and 'worker' in locals():
            print([{'model': r['model'], 'tools': [t.get('name') for t in r.get('tools', [])], 'results': [i for i in r.get('input', []) if i['type'].endswith('call_output')]} for r in request(fixture + '/records')[1]])
        raise
    finally:
        compose('down', '--volumes', '--remove-orphans', check=False)
        # Codex and Paper use UID 1000. Remove only this test's generated private state.
        docker('run', '--rm', '--network', 'none', '--user', '0:0', '-v', f'{root}:/test-state', IMAGE,
               'node', '-e', "const fs=require('node:fs');for(const p of ['/test-state/data','/test-state/ai-auth'])fs.rmSync(p,{recursive:true,force:true})", check=False)
