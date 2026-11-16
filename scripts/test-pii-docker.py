"""Test a built image without network access, real credentials, or persistent data."""
import argparse
import json
import os
import secrets
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="criterion-pii:staging")
    args = parser.parse_args()
    env = {**os.environ, "PII_ANALYZER_TOKEN": secrets.token_hex(32)}

    def docker(*command, check=True):
        result = subprocess.run(["docker", *command], env=env, capture_output=True, text=True, timeout=60)
        if check and result.returncode:
            raise RuntimeError("Docker check failed: " + command[0])
        return result

    container = docker("run", "--detach", "--rm", "--read-only", "--network", "none",
                       "--tmpfs", "/tmp:size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                       "--memory", "1g", "--cpus", "1", "--pids-limit", "128",
                       "--env", "PII_ANALYZER_TOKEN", args.image).stdout.strip()
    try:
        for _ in range(45):
            health = docker("exec", container, "python", "-m", "services.pii.healthcheck", check=False)
            if health.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Container did not become ready")
        smoke = docker("exec", container, "python", "scripts/check-pii-endpoint.py", "--url", "http://127.0.0.1:8100/analyze")
        assert json.loads(smoke.stdout)["ok"] is True
        docker("exec", container, "python", "-c", "import os,pathlib; assert os.getuid()!=0; assert 'OPENAI_API_KEY' not in os.environ; assert not pathlib.Path('/app/.dev.vars').exists(); assert not pathlib.Path('/app/.git').exists()")
        memory = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", container).stdout.strip()
        print(json.dumps({"containerSmoke": "passed", "network": "none", "readOnly": True,
                          "nonRoot": True, "modelCalls": 0, "memoryAtCheck": memory}))
    finally:
        docker("rm", "--force", container, check=False)


if __name__ == "__main__":
    main()
