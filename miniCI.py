#!/usr/bin/env python3
# Steven Correa
# miniCI is a minimal CI runner executed via a commit hook
#
# Prerequisites:
# - Python 3
# - Git
# - A git repo


import os
import subprocess
import sys
from datetime import datetime

CONFIG_FILE = ".minici"
# if no config, assume it's a bun project and run build
DEFAULT_STEPS = ["bun build"]
VERSION = "1.0"


# Get the absolute path to the repo root
def get_repo_root():
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
    )
    if result.returncode != 0:
        print("miniCI: not inside a git repository", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


# if the config file doesn't exist, assume it's a bun project and run build
def load_steps(repo_root):
    config_path = os.path.join(repo_root, CONFIG_FILE)
    if not os.path.exists(config_path):
        return DEFAULT_STEPS
    with open(config_path) as f:
        steps = [
            # strip comments and empty lines
            # Looked this one up, makes sense
            line.strip() for line in f if line.strip() and not line.startswith("#")
        ]
    return steps if steps else DEFAULT_STEPS


# Run a single step using subprocess convention learned in class
def run_step(step, cwd):
    result = subprocess.run(step, shell=True, cwd=cwd, capture_output=True, text=True)
    return result.returncode, result.stdout, result.stderr


# ---end helper functions ---
# ---begin main---


# Main function that runs the steps from the config file
def main():
    repo_root = get_repo_root()
    steps = load_steps(repo_root)

    print(f"\n miniCI v{VERSION}  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"repo: {repo_root}\n")

    # pass/fail counters for steps
    passed = 0
    failed = 0

    for step in steps:
        print(f"RUNNING {step}")
        code, out, err = run_step(step, repo_root)
        if code == 0:
            print(f"PASSED {step}")
            passed += 1
        else:
            print(f"FAILED {step}")
            if out:
                print(out)
            if err:
                print(err, file=sys.stderr)
            failed += 1

    print(f"\n~~~ {passed} CI steps passed, \n {failed} CI steps failed ~~~\n")

    # all steps must pass for commit hook to be satisfied
    if failed > 0:
        print("miniCI: push blocked, please fix the above failures", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
