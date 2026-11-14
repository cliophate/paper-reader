"""Shared command boundary for disposable container installation checks."""
import subprocess


def container(*arguments, check=True, timeout=60):
    result = subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Container test operation failed: ' + result.stderr.strip())
    return (result.stdout + (result.stderr if arguments[0] == 'logs' else '')).strip()
