import subprocess
import unittest
from unittest.mock import patch

from container_engine import container


class ContainerEngineTest(unittest.TestCase):
    @patch('container_engine.subprocess.run')
    def test_preserves_arguments_and_deadline(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'container-id\n', '')
        self.assertEqual(container('run', '--name', 'synthetic', 'image', timeout=180), 'container-id')
        run.assert_called_once_with(['docker', 'run', '--name', 'synthetic', 'image'], capture_output=True, text=True, timeout=180)

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
