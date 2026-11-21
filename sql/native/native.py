"""Create an isolated local PostgreSQL cluster for the two-connection replay."""

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile

from embedded_postgres._commands import POSTGRES_BIN_PATH


with tempfile.TemporaryDirectory(prefix="zcg-pg-proof-") as directory:
    root = Path(directory)
    cluster = root / "cluster"
    password = secrets.token_urlsafe(32)
    password_file = root / "password"
    password_file.write_text(password + "\n", encoding="utf-8")
    password_file.chmod(0o600)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    binary = Path(POSTGRES_BIN_PATH)
    subprocess.run([binary / "initdb", "-D", cluster, "-U", "reviewer",
                    "--auth=scram-sha-256", "--pwfile", password_file,
                    "--encoding=UTF8", "--no-locale"], check=True, stdout=subprocess.DEVNULL)
    password_file.unlink()
    with (cluster / "postgresql.conf").open("a", encoding="utf-8") as config:
        config.write(f"\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = ''\n")
    ctl = [binary / "pg_ctl", "-D", cluster, "-w"]
    subprocess.run([*ctl, "-l", root / "postgres.log", "start"], check=True, stdout=subprocess.DEVNULL)
    try:
        subprocess.run([binary / "createdb", "-h", "127.0.0.1", "-p", str(port),
                        "-U", "reviewer", "zcg_review_only"],
                       check=True, env={**os.environ, "PGPASSWORD": password})
        subprocess.run(
            ["node", str(Path(__file__).with_name("check.mjs"))],
            input=json.dumps({"port": port, "password": password}).encode(),
            check=True,
        )
    finally:
        subprocess.run([*ctl, "stop"], check=True, stdout=subprocess.DEVNULL)
