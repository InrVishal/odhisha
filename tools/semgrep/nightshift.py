# Examples for .semgrep/nightshift.yml, checked by `semgrep --test .semgrep`.
# Never imported or run.
import os
import subprocess


def shell(user_input):
    # ruleid: py-no-shell-true
    subprocess.run(user_input, shell=True)
    # ok: py-no-shell-true
    subprocess.run(["docker", "run", user_input], shell=False)


def code(user_input):
    # ruleid: py-no-eval-exec
    eval(user_input)
    # ruleid: py-no-eval-exec
    exec(user_input)


def system(user_input):
    # ruleid: py-no-os-system
    os.system(user_input)
    # ruleid: py-no-os-system
    os.popen(user_input)
