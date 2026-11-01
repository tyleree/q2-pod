#!/usr/bin/env python3
"""Writes Q2 Theme Studio's built-in presets from the AutoEq project's published parametric EQs.

python3 tools/theme_presets.py tools/theme-studio/ui/presets.json

Every parametric EQ AutoEq publishes goes in, one per model and measurement, for the Studio to search.
TOP is the short list it shows before a search: IEMs most people have heard of, a choice of ours, as
nobody publishes a ranking to take it from. The published results are used as they are, so nothing here
needs AutoEq installed. A commit is pinned so that the list can be rebuilt byte for byte."""
import json
import pathlib
import subprocess
import sys
import tempfile

REPO = 'https://github.com/jaakkopasanen/AutoEq.git'
COMMIT = '7ae0f56d53074872b028649617a22bbb4232feb7'
CRINACLE = 'crinacle/711 in-ear'
ORATORY = 'oratory1990/in-ear'
FIRST = ('oratory1990', 'crinacle')  # a model's sources in a search: these, then the rest by name
MAX_BYTES = 2048

# The source and AutoEq's folder, and the name people know it by.
TOP = {
    (CRINACLE, '64 Audio U12t'): '64 Audio U12t',
    (CRINACLE, '7Hz Salnotes Zero'): '7Hz Salnotes Zero',
    (CRINACLE, '7Hz Timeless'): '7Hz Timeless',
    (CRINACLE, 'Apple AirPods Pro'): 'Apple AirPods Pro',
    (CRINACLE, 'Beyerdynamic Xelento'): 'Beyerdynamic Xelento',
    (CRINACLE, 'BLON BL-03'): 'BLON BL-03',
    (CRINACLE, 'Campfire Audio Andromeda'): 'Campfire Audio Andromeda',
    (CRINACLE, 'Etymotic ER4XR'): 'Etymotic ER4XR',
    (CRINACLE, 'Final Audio E3000'): 'Final E3000',
    (CRINACLE, 'KZ ZSN Pro'): 'KZ ZSN Pro',
    (CRINACLE, 'Shuoer S12'): 'Letshuoer S12',
    (ORATORY, 'Moondrop Aria'): 'Moondrop Aria',
    (CRINACLE, 'Moondrop Blessing 2'): 'Moondrop Blessing 2',
    (CRINACLE, 'Moondrop Blessing 3'): 'Moondrop Blessing 3',
    (CRINACLE, 'Moondrop Chu 2'): 'Moondrop Chu 2',
    (CRINACLE, 'Moondrop Starfield'): 'Moondrop Starfield',
    (CRINACLE, 'Moondrop Variations'): 'Moondrop Variations',
    (CRINACLE, 'Sennheiser IE 300'): 'Sennheiser IE 300',
    (CRINACLE, 'Sennheiser IE 600'): 'Sennheiser IE 600',
    (CRINACLE, 'Sennheiser IE 900'): 'Sennheiser IE 900',
    (CRINACLE, 'Shure SE215'): 'Shure SE215',
    (ORATORY, 'Shure SE846'): 'Shure SE846',
    (CRINACLE, 'Sony IER-Z1R'): 'Sony IER-Z1R',
    (CRINACLE, 'Tin HiFi T2'): 'Tin HiFi T2',
    (CRINACLE, 'Truthear x Crinacle Zero'): 'Truthear Zero',
}


def checkout(path):
    """The one commit's parametric EQs alone: the repository's images run to gigabytes."""
    def git(*args):
        subprocess.run(['git', '-C', str(path), *args], check=True)
    git('init', '-q')
    git('remote', 'add', 'origin', REPO)
    git('sparse-checkout', 'set', '--no-cone', '/results/**/*ParametricEQ.txt')
    git('fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', COMMIT)
    git('checkout', '-q', 'FETCH_HEAD')


def presets(results):
    """results/<source>/<rig and form>/<model>/<model> ParametricEQ.txt, data only: eq.parse reads it."""
    out = []
    for file in results.rglob('*ParametricEQ.txt'):
        parts = file.relative_to(results).parts
        assert len(parts) == 4, file
        source, form, folder = parts[:3]
        text = file.read_text(encoding='utf-8').replace('\r\n', '\n')
        assert text.startswith('Preamp:') and len(text) < MAX_BYTES, file
        words = form.split()
        name = TOP.get((f'{source}/{form}', folder))
        preset = {'name': name or folder, 'source': ' '.join([source, *words[:-1]]), 'type': words[-1], 'text': text}
        out.append({**preset, 'top': 1} if name else preset)
    assert sum('top' in p for p in out) == len(TOP)
    return sorted(out, key=lambda p: (p['name'].lower(), not p['source'].startswith(FIRST), p['source']))


def main(out):
    with tempfile.TemporaryDirectory(prefix='autoeq-', dir=pathlib.Path.home()) as directory:
        checkout(directory)
        found = presets(pathlib.Path(directory)/'results')
    credit = ('Parametric EQs from the AutoEq project, github.com/jaakkopasanen/AutoEq, MIT licence, '
              'computed from measurements by Crinacle, oratory1990, Rtings and others.')
    pathlib.Path(out).write_text(json.dumps({'credit': credit, 'commit': COMMIT, 'presets': found},
                                            ensure_ascii=False, separators=(',', ':')) + '\n')
    print(len(found), 'presets')


if __name__ == '__main__':
    main(sys.argv[1])
