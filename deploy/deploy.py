"""Upload the current working tree; credentials never enter the archive or argv."""
from __future__ import annotations

import argparse
import base64
import codecs
import hashlib
import io
import os
from pathlib import Path
import shlex
import sys
import tarfile
import tempfile

import paramiko
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', '.deploy', '.agents', '.codex', '.aws', '.ssh', 'node_modules',
            'dist', 'dist-ssr', 'data', 'coverage', '.venv', 'venv', '__pycache__',
            '.pytest_cache', '.vscode', '.idea'}


def excluded(name: str) -> bool:
    return name in EXCLUDED or name == '.env' or name.startswith('.env.') or name.endswith('.log')


def source_files(root: Path):
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not excluded(d) and not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if not excluded(name) and not path.is_symlink():
                # Windows junctions/reparse points must not escape the project either.
                if not path.resolve().is_relative_to(root.resolve()):
                    raise ValueError('项目中有指向外部的文件，拒绝打包。')
                yield path


def build_archive(root: Path, destination: Path) -> int:
    count = 0
    with tarfile.open(destination, 'w:gz') as archive:
        for path in source_files(root):
            relative = path.relative_to(root).as_posix()
            info = archive.gettarinfo(str(path), arcname=relative)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mode = 0o755 if path.suffix == '.sh' else 0o644
            if path.suffix == '.sh':
                content = path.read_bytes().replace(b'\r\n', b'\n')
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            else:
                with path.open('rb') as handle:
                    archive.addfile(info, handle)
            count += 1
    return count


def load_config(root: Path) -> dict:
    if not (root / '.env').is_file():
        raise ValueError('缺少根目录 .env，请按 .env.example 填写 SSH 连接信息。')
    values = dotenv_values(root / '.env', encoding='utf-8-sig', interpolate=False)
    for field in ('SERVER_HOST', 'SERVER_USER'):
        if not values.get(field):
            raise ValueError(f'根目录 .env 缺少 {field}。')
    port = int(values.get('SERVER_PORT') or '22')
    if not 1 <= port <= 65535:
        raise ValueError('SERVER_PORT 必须在 1 到 65535 之间。')
    path = values.get('SERVER_DEPLOY_PATH') or '/opt/predict-game'
    if (not path.startswith('/') or path.rstrip('/') in ('', '/opt', '/home', '/usr', '/var', '/tmp', '/etc', '/srv', '/root', '/bin', '/sbin', '/lib', '/boot', '/dev', '/proc', '/sys', '/run')
            or any(part in ('.', '..') for part in path.split('/')) or '\n' in path or '\r' in path):
        raise ValueError('SERVER_DEPLOY_PATH 必须是专用的绝对项目目录，不能是系统目录。')
    key = values.get('SERVER_SSH_KEY') or None
    if key:
        key_path = Path(key).expanduser()
        if not key_path.is_absolute():
            key_path = root / key_path
        key_path = key_path.resolve()
        if not key_path.is_file():
            raise ValueError('SERVER_SSH_KEY 指定的私钥文件不存在。')
        if key_path.is_relative_to(root.resolve()):
            raise ValueError('SSH 私钥请存放在项目目录之外（如 ~/.ssh/），避免随代码上传。')
        key = str(key_path)
    return dict(host=values['SERVER_HOST'], user=values['SERVER_USER'],
                key=key, port=port, path=path.rstrip('/'))


def connect_client(client, config: dict) -> None:
    # With password=None, Paramiko only tries public keys (including SSH Agent).
    client.connect(config['host'], port=config['port'], username=config['user'],
                   key_filename=config['key'], password=None,
                   look_for_keys=not bool(config['key']), allow_agent=True,
                   timeout=20, auth_timeout=30, banner_timeout=30)


class PinFirstHostKey(paramiko.MissingHostKeyPolicy):
    def __init__(self, filename: Path):
        self.filename = filename

    def missing_host_key(self, client, hostname, key):
        fingerprint = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        print(f'首次连接，保存服务器 SSH 指纹 SHA256:{fingerprint}', flush=True)
        client.get_host_keys().add(hostname, key.get_name(), key)
        client.save_host_keys(str(self.filename))


def run(client, command: str, script: str | None = None, capture=False) -> str:
    stdin, stdout, stderr = client.exec_command(command)
    channel = stdout.channel
    channel.set_combine_stderr(True)
    if script is not None:
        stdin.write(script)
        stdin.flush()
    channel.shutdown_write()
    chunks = []
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    # Drain the channel while it runs so Docker output cannot fill the SSH window.
    while True:
        chunk = channel.recv(32768)
        if not chunk:
            break
        decoded = decoder.decode(chunk)
        if capture:
            chunks.append(decoded)
        else:
            print(decoded, end='', flush=True)
    tail = decoder.decode(b'', final=True)
    if capture:
        chunks.append(tail)
    elif tail:
        print(tail, end='', flush=True)
    if channel.recv_exit_status() != 0:
        raise RuntimeError('服务器命令失败，请按上方提示处理后重试。')
    return ''.join(chunks).strip()


def remote_script(path: str, archive: str) -> str:
    # The root .env is deliberately never evaluated by a shell.
    exclusions = sorted(EXCLUDED | {'.env', '.env.*', '*.log'})
    flags = ' '.join('--exclude=' + shlex.quote('/' + name + '/' if name in EXCLUDED else name)
                     for name in exclusions)
    return f'''set -euo pipefail
root={shlex.quote(path)}
archive={shlex.quote(archive)}
exec 9> "$root/.deploy.lock"
flock -n 9 || {{ echo '已有部署正在运行，请稍后重试。' >&2; exit 1; }}
stage=$(mktemp -d /tmp/predict-game-release.XXXXXXXX)
trap 'rm -rf -- "$stage"; rm -f -- "$archive"' EXIT
tar -xzf "$archive" -C "$stage"
# Refuse root symlinks: rsync must only write to the configured checkout.
test ! -L "$root" || {{ echo '部署目录不能是符号链接。' >&2; exit 1; }}
test -f "$root/deploy/.env"
# Validate the existing runtime configuration and market data before changing code.
(
  source "$stage/deploy/common.sh"
  cd "$root/deploy"
  load_env
  require_docker
  require_password
  require_site
  if ! processed_ready "$root/data"; then require_raw_bars "$root/data"; fi
)
if [ -f "$root/data/app.sqlite" ]; then
  echo '更新前备份账户和对局…'
  bash "$root/deploy/backup.sh"
fi
echo '同步最新代码（保留服务器配置、数据和卷）…'
rsync -a --delete {flags} --exclude='/.deploy.lock' "$stage/" "$root/"
echo '构建镜像并启动生产服务…'
cd "$root"
bash deploy/up.sh
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='检查配置和打包，不连接服务器')
    args = parser.parse_args()
    config = load_config(ROOT)
    with tempfile.TemporaryDirectory(prefix='predict-game-') as temporary:
        archive = Path(temporary) / 'release.tar.gz'
        count = build_archive(ROOT, archive)
        print(f'部署包：{count} 个文件，{archive.stat().st_size / 1024 / 1024:.1f} MB；已排除环境配置和 data。', flush=True)
        if args.dry_run:
            print('本地检查通过；未连接服务器。')
            return 0
        state = ROOT / '.deploy'
        state.mkdir(exist_ok=True)
        known_hosts = state / 'known_hosts'
        with paramiko.SSHClient() as client:
            client.load_system_host_keys()
            if known_hosts.exists():
                client.load_host_keys(str(known_hosts))
            client.set_missing_host_key_policy(PinFirstHostKey(known_hosts))
            print('连接服务器并检查部署条件…', flush=True)
            connect_client(client, config)
            client.get_transport().set_keepalive(30)
            path = shlex.quote(config['path'])
            run(client, 'bash -s', f'''set -euo pipefail
for tool in bash tar rsync flock docker; do
  command -v "$tool" >/dev/null || {{ echo "服务器缺少 $tool（rsync 可用 sudo apt-get install -y rsync 安装）。" >&2; exit 1; }}
done
docker compose version >/dev/null
docker info >/dev/null
test -d {path} && test -w {path} && test ! -L {path} || {{ echo '部署目录不存在、不可写或是符号链接，请先按 DEPLOY.md 完成首次部署。' >&2; exit 1; }}
test -f {path}/deploy/.env || {{ echo '缺少服务器 deploy/.env，请按 DEPLOY.md 配置，脚本不会上传本机环境文件。' >&2; exit 1; }}
''')
            remote_archive = run(client, 'mktemp /tmp/predict-game-upload.XXXXXXXX.tar.gz', capture=True)
            if not remote_archive.startswith('/tmp/predict-game-upload.') or '\n' in remote_archive:
                raise RuntimeError('服务器返回的临时文件路径无效。')
            try:
                print('上传最新代码…', flush=True)
                with client.open_sftp() as sftp:
                    sftp.put(str(archive), remote_archive)
                run(client, 'bash -s', remote_script(config['path'], remote_archive))
            finally:
                run(client, 'rm -f -- ' + shlex.quote(remote_archive))
    print('部署成功：应用健康检查已通过。')
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(errors='replace')
    sys.stderr.reconfigure(errors='replace')
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n部署已中断；请检查服务器状态后重试。', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # Never print arbitrary SSH exceptions: they can contain connection details.
        if isinstance(error, paramiko.PasswordRequiredException):
            print('部署失败：私钥已加密，请先用 ssh-add 将私钥加入 SSH Agent，再执行部署。', file=sys.stderr)
        elif isinstance(error, paramiko.AuthenticationException):
            print('部署失败：SSH 密钥认证失败，请确认对应公钥已加入服务器用户的 ~/.ssh/authorized_keys；加密私钥请先用 ssh-add 加入 SSH Agent。', file=sys.stderr)
        elif isinstance(error, (ValueError, RuntimeError)):
            print(f'部署失败：{error}', file=sys.stderr)
        else:
            print(f'部署失败（{type(error).__name__}）：请检查网络、SSH 凭据或服务器指纹。', file=sys.stderr)
        sys.exit(1)
