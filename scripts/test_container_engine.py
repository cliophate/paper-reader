import subprocess
import unittest
from unittest.mock import patch

from container_engine import container


class ContainerEngineTest(unittest.TestCase):
    @patch('container_engine.ENGINE', 'docker')
    @patch('container_engine.subprocess.run')
    def test_preserves_arguments_and_deadline(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'container-id\n', '')
        self.assertEqual(container('run', '--name', 'synthetic', 'image', timeout=180), 'container-id')
        run.assert_called_once_with(['docker', 'run', '--name', 'synthetic', 'image'], capture_output=True, text=True, timeout=180)

    @patch('container_engine.ENGINE', '/usr/bin/podman')
    @patch('container_engine.subprocess.run')
    def test_adds_keep_id_and_labels_for_rootless_bind_mounts(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'fixture\n', '')
        container('run', '--user', '1000:1000', '-v', '/fixture:/fixture:ro', '-v', '/data:/data', 'image')
        self.assertEqual(run.call_args.args[0], ['/usr/bin/podman', 'run', '--userns=keep-id', '--user', '1000:1000', '-v', '/fixture:/fixture:ro,z', '-v', '/data:/data:Z', 'image'])

    @patch('container_engine.ENGINE', 'docker')
    @patch('container_engine.subprocess.run')
    def test_keeps_docker_mounts_and_user_options_unchanged(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, '', '')
        arguments = ('run', '--user', '1000:1000', '-v', '/data:/data', 'image')
        container(*arguments)
        self.assertEqual(run.call_args.args[0], ['docker', *arguments])

    @patch('container_engine.ENGINE', 'podman')
    @patch('container_engine.subprocess.run')
    def test_preserves_explicit_namespace_and_existing_labels(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, '', '')
        container('run', '--user=1000', '--userns=keep-id', '--volume', '/data:/data:Z', '-v', '/fixture:/fixture:ro,z', 'image')
        self.assertEqual(run.call_args.args[0].count('--userns=keep-id'), 1)
        self.assertIn('/data:/data:Z', run.call_args.args[0])
        self.assertIn('/fixture:/fixture:ro,z', run.call_args.args[0])

    @patch('container_engine.subprocess.run')
    def test_combines_logs_from_both_streams(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'output\n', 'diagnostic\n')
        self.assertEqual(container('logs', 'synthetic'), 'output\ndiagnostic')

    @patch('container_engine.subprocess.run')
    def test_rejects_failure_except_during_best_effort_cleanup(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, '', 'synthetic failure\n')
        with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
            container('rm', 'synthetic')
        self.assertEqual(container('rm', 'synthetic', check=False), '')


if __name__ == '__main__':
    unittest.main()
