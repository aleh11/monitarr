import json
import os
import subprocess
from pathlib import Path


def container(name):
    return json.loads(subprocess.check_output(["docker", "inspect", name], text=True))[0]


def setup():
    monitor = container("monitor")
    seerr = container("seerr")
    data_path = next(m["Source"] for m in monitor["Mounts"] if m["Destination"] == "/data")
    source_path = next(m["Source"] for m in seerr["Mounts"] if m["Destination"] == "/app/config")
    environment = dict(value.split("=", 1) for value in container("caddy")["Config"]["Env"] if "=" in value)
    domain = environment.get("DOMAIN", "")
    command = " ".join(container("caddy")["Config"].get("Cmd") or [])
    scheme = "http" if "Caddyfile.http" in command else "https"
    public_url = f"{scheme}://seerr.{domain}" if domain else ""
    jellyfin_url = f"{scheme}://jellyfin.{domain}" if domain else ""
    script = """
import json, os, tempfile
from pathlib import Path
settings = json.loads(Path('/run/seerr/settings.json').read_text())
key = settings.get('main', {}).get('apiKey')
if not key:
    raise SystemExit('Seerr has no integration key. Complete Seerr setup and redeploy Monitor.')
connection = {'url': 'http://seerr:5055', 'key': key,
              'public_url': settings.get('main', {}).get('applicationUrl') or os.environ['PUBLIC_SEERR'],
              'jellyfin_url': settings.get('jellyfin', {}).get('externalHostname') or os.environ['PUBLIC_JELLYFIN']}
fd, path = tempfile.mkstemp(prefix='.seerr-', dir='/data')
try:
    with os.fdopen(fd, 'w') as stream:
        json.dump(connection, stream)
    os.chmod(path, 0o600)
    os.chown(path, 1000, 1000)
    os.replace(path, '/data/seerr-connection.json')
finally:
    if os.path.exists(path):
        os.unlink(path)
print('Seerr connection saved privately. No requests were submitted.')
"""
    subprocess.run(["docker", "run", "--rm", "--network", "none", "--user", "0:0",
                    "--mount", f"type=bind,source={source_path}/settings.json,target=/run/seerr/settings.json,readonly",
                    "--mount", f"type=bind,source={data_path},target=/data",
                    "-e", f"PUBLIC_SEERR={public_url}", "-e", f"PUBLIC_JELLYFIN={jellyfin_url}",
                    "--entrypoint", "python", os.environ["IMAGE"] + ":sha-" + os.environ["DEPLOY_SHA"],
                    "-c", script], check=True)


if __name__ == "__main__":
    setup()
