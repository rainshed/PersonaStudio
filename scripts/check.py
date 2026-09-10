#!/usr/bin/env python3
"""Run application checks in isolated local state; no provider accounts are used."""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP = REPO / "apps/ai-persona"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-only", action="store_true", help="run only model runtime checks")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="personastudio-check-") as directory:
        temporary = Path(directory)
        env = {key: value for key, value in os.environ.items() if not key.startswith("AI_PERSONA_")}
        env.update({"PYTHONPATH": str(APP / "src"),
               "AI_PERSONA_CONFIG": str(temporary / "config.toml"),
               "AI_PERSONA_DEMO_HOME": str(temporary / "demo"),
               "AI_PERSONA_MODEL_DATA_DIR": str(temporary / "accounts"),
               "AI_PERSONA_LEARNING_DIR": str(temporary / "learning"),
               "AI_PERSONA_MODEL_RUNTIME_CACHE_DIR": str(temporary / "runtime-cache")})

        def run(args, cwd=APP):
            subprocess.run(args, cwd=cwd, env=env, check=True)

        uv = ["uv", "run", "--locked", "--no-editable", "--extra", "dev"]
        run([*uv, "ruff", "check", "."])
        run([*uv, "ai-persona", "models-install"])
        if not args.runtime_only:
            run([*uv, "pytest", "-q"])
            run(["node", "--test", *map(str, sorted((APP / "tests").glob("test_*.mjs")))])
        probe = subprocess.check_output(
            [*uv, "python", "-c", "import json; from ai_persona.runtime_support import runtime_directory; print(json.dumps(str(runtime_directory())))"],
            cwd=APP, env=env, text=True,
        )
        runtime = temporary / "runtime-tests"
        shutil.copytree(APP / "src/ai_persona/model_runtime", runtime,
                        ignore=shutil.ignore_patterns("node_modules", "__pycache__", ".DS_Store"))
        # Runtime tests also verify the labels used by the adjacent Studio UI.
        shutil.copytree(APP / "src/ai_persona/static", temporary / "static")
        (runtime / "node_modules").symlink_to(Path(json.loads(probe)) / "node_modules", target_is_directory=True)
        run(["node", "--experimental-strip-types", "--test",
             *map(str, sorted((runtime / "tests").glob("*.test.mjs")))], cwd=runtime)
    print("Model runtime checks passed." if args.runtime_only
          else "Python, browser-side JavaScript and model runtime checks passed.")


if __name__ == "__main__":
    main()
