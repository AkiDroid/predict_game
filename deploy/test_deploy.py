import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('deploy_script', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def test_archive_excludes_nested_credentials_and_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'project'
            root.mkdir()
            for name in ('.env', '.env.example', 'deploy/.env', 'src/.env.backup',
                         'data/app.sqlite', '.deploy/known_hosts', '.ssh/id_rsa', 'node_modules/a.js',
                         'src/hidden/.env.copy/password.txt', 'src/main.ts', 'deploy/up.sh'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'content\r\n')
            target = Path(temporary) / 'release.tar.gz'
            deploy.build_archive(root, target)
            with tarfile.open(target) as archive:
                self.assertEqual(set(archive.getnames()), {'src/main.ts', 'deploy/up.sh'})
                self.assertEqual(archive.extractfile('deploy/up.sh').read(), b'content\n')
                self.assertEqual(archive.getmember('deploy/up.sh').mode, 0o755)

    def test_config_needs_no_password_and_ignores_legacy_password(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.env').write_text(
                'SERVER_HOST=example.invalid\nSERVER_USER=deploy\nSERVER_SSH_KEY=\n',
                encoding='utf-8')
            config = deploy.load_config(root)
            self.assertIsNone(config['key'])
            self.assertEqual(config['port'], 22)
            self.assertEqual(config['path'], '/opt/predict-game')
            with (root / '.env').open('a', encoding='utf-8') as handle:
                handle.write("SERVER_PASSWORD='ignored${HOME}'\n")
            self.assertEqual(deploy.load_config(root), config)

    def test_ssh_uses_agent_and_default_keys_without_password(self):
        client = Mock()
        deploy.connect_client(client, dict(host='example.invalid', port=22, user='deploy', key=None))
        options = client.connect.call_args.kwargs
        self.assertIsNone(options['password'])
        self.assertTrue(options['allow_agent'])
        self.assertTrue(options['look_for_keys'])

    def test_explicit_key_and_missing_key_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'project'
            root.mkdir()
            key = Path(temporary) / 'custom key'
            key.write_text('test placeholder', encoding='utf-8')
            (root / '.env').write_text(
                f"SERVER_HOST=example.invalid\nSERVER_USER=deploy\nSERVER_SSH_KEY='{key.as_posix()}'\n",
                encoding='utf-8')
            config = deploy.load_config(root)
            self.assertEqual(config['key'], str(key.resolve()))
            client = Mock()
            deploy.connect_client(client, config)
            self.assertEqual(client.connect.call_args.kwargs['key_filename'], str(key.resolve()))
            self.assertFalse(client.connect.call_args.kwargs['look_for_keys'])
            key.unlink()
            with self.assertRaises(ValueError):
                deploy.load_config(root)

    def test_refuses_unsafe_deployment_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path in ('/', '/etc', '/opt/../etc', 'relative', '/home'):
                (root / '.env').write_text(
                    'SERVER_HOST=example.invalid\nSERVER_USER=deploy\n'
                    f'SERVER_DEPLOY_PATH={path}\n', encoding='utf-8')
                with self.assertRaises(ValueError):
                    deploy.load_config(root)

    def test_remote_sync_preserves_config_data_and_deployment_lock(self):
        script = deploy.remote_script("/opt/project with 'quotes'", '/tmp/archive.tar.gz')
        self.assertIn("--exclude=.env ", script)
        self.assertIn("--exclude='.env.*'", script)
        self.assertIn('--exclude=/data/', script)
        self.assertIn("--exclude='/.deploy.lock'", script)
        self.assertLess(script.index('require_site'), script.index('rsync -a'))
        self.assertLess(script.index('backup.sh'), script.index('rsync -a'))
        self.assertIn('flock -n 9', script)


if __name__ == '__main__':
    unittest.main()
