"""Shared command boundary for disposable container installation checks."""
import os
from pathlib import Path
import subprocess

ENGINE = os.environ.get('PAPER_CONTAINER_ENGINE', 'docker')


def is_podman():
    return Path(ENGINE).name == 'podman'


def container(*arguments, check=True, timeout=60):
    args = list(arguments)
    if is_podman() and args[0] == 'run':
        if any(value == '--user' or value.startswith('--user=') for value in args) and not any(value.startswith('--userns') for value in args):
            args.insert(1, '--userns=keep-id')
        for index, value in enumerate(args):
            if index and args[index - 1] in ('-v', '--volume') and not value.endswith((':Z', ':z', ',Z', ',z')):
                args[index] = value + (',z' if value.endswith(':ro') else ':Z')
    result = subprocess.run([ENGINE, *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Container test operation failed: ' + result.stderr.strip())
    return (result.stdout + (result.stderr if arguments[0] == 'logs' else '')).strip()
